import { listRows, saveRows } from '@/data/local-store'
import { allNcrOrders, resetNcrOrders, saveNcrOrders } from '@/data/ncr-store'
import {
  DISPOSITION_PRIORITY,
  DISPOSITIONS,
  FORWARD_TRANSITIONS,
  QA_DEPARTMENT,
  RECHECK_RESULTS,
  STATUS_RANK,
} from '@/data/ncr-types'
import type {
  Disposition,
  NcrActionResult,
  NcrOrder,
  NcrStatus,
  RecheckResult,
  TimelineEvent,
} from '@/data/ncr-types'
import type { EntryRow } from '@/data/types'

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function pad(value: number, size = 4): string {
  return String(value).padStart(size, '0')
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowStamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

/** 非法值一律打回：处置结论只认白名单里的三个值。 */
export function parseDisposition(value: string): Disposition {
  const trimmed = value.trim()
  if (!DISPOSITIONS.includes(trimmed as Disposition)) {
    throw new IllegalFieldError(
      `处置结论「${trimmed || '（空）'}」为非法值，合法值仅支持：${DISPOSITIONS.join('、')}，请打回重填`,
    )
  }
  return trimmed as Disposition
}

function parseRecheckResult(value: string): RecheckResult {
  const trimmed = value.trim()
  if (!RECHECK_RESULTS.includes(trimmed as RecheckResult)) {
    throw new IllegalFieldError(
      `复检结论「${trimmed || '（空）'}」为非法值，合法值仅支持：${RECHECK_RESULTS.join('、')}，请打回重填`,
    )
  }
  return trimmed as RecheckResult
}

/** 非法值错误：视图层据此把表单留在屏上，让用户重填而不是丢数据。 */
export class IllegalFieldError extends Error {}

function fail(message: string, duplicated = false): NcrActionResult {
  return { ok: false, message, duplicated }
}

function ok(order: NcrOrder, message: string, duplicated = false): NcrActionResult {
  return { ok: true, message, duplicated, order: cloneOrder(order) }
}

function cloneOrder(order: NcrOrder): NcrOrder {
  return JSON.parse(JSON.stringify(order)) as NcrOrder
}

function persist(orders: NcrOrder[], target: NcrOrder): void {
  const index = orders.findIndex((item) => item.id === target.id)
  const next = [...orders]
  next[index >= 0 ? index : next.length] = cloneOrder(target)
  saveNcrOrders(next)
  syncDeviationTodos()
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export type NcrFilters = {
  keyword: string
  status: string
  disposition: string
  abnormal: string
}

export function listNcrOrders(filters?: Partial<NcrFilters>): NcrOrder[] {
  let rows = allNcrOrders().map(cloneOrder)
  if (filters) {
    const keyword = filters.keyword?.trim() ?? ''
    if (keyword) {
      rows = rows.filter((row) =>
        [row.code, row.batchNo, row.productName, row.sourceNo, row.nonConformity, row.foundBy]
          .join(' ')
          .includes(keyword),
      )
    }
    if (filters.status) {
      rows = rows.filter((row) => row.status === filters.status)
    }
    if (filters.disposition) {
      rows = rows.filter((row) => row.disposition === filters.disposition)
    }
    if (filters.abnormal === '是') {
      rows = rows.filter((row) => row.abnormal)
    }
  }
  return rows.sort((a, b) => b.id - a.id)
}

export function getNcrOrder(id: number): NcrOrder | undefined {
  const found = allNcrOrders().find((row) => row.id === id)
  return found ? cloneOrder(found) : undefined
}

/** 当前持有人：单子停在谁手里就算谁的。 */
export function holderFor(order: NcrOrder): { name: string; department: string } {
  switch (order.status) {
    case '待评审':
      return { name: '质量部待派评审人', department: QA_DEPARTMENT }
    case '已评审':
      return { name: order.reviewer || '质量部', department: QA_DEPARTMENT }
    case '返工中':
    case '返修中':
      return { name: order.executor || '执行车间（待派工）', department: '生产/包装车间' }
    case '让步待办':
      return { name: order.concessionApprover || order.reviewer || '质量部', department: `${QA_DEPARTMENT}（让步放行）` }
    case '待复检':
      return { name: 'QC 复检员', department: 'QC化验室' }
    case '办结':
    default:
      return { name: '已办结归档', department: QA_DEPARTMENT }
  }
}

/** 滞留天数：在当前持有人手里压了几天；办结单不再计时。 */
export function heldDays(order: NcrOrder, today = todayStr()): number | null {
  if (order.status === '办结') {
    return null
  }
  const start = new Date(`${order.heldSince}T00:00:00`).getTime()
  const end = new Date(`${today}T00:00:00`).getTime()
  if (Number.isNaN(start)) {
    return null
  }
  return Math.max(0, Math.round((end - start) / 86400000))
}

/* ------------------------------------------------------------------ */
/* 状态机守卫：状态只能往下流转，跳级、回退、走错车道一律拒收          */
/* ------------------------------------------------------------------ */

function guardTransition(
  order: NcrOrder,
  target: NcrStatus,
  actionName: string,
): { allowed: true } | { allowed: false; message: string } {
  if (order.status === '办结') {
    return { allowed: false, message: `处置单 ${order.code} 已办结，不能再执行「${actionName}」` }
  }
  const allowedTargets = FORWARD_TRANSITIONS[order.status]
  if (!allowedTargets.includes(target)) {
    // 区分两种拒收：平级重复 vs 跳级/回退，提示里把话说清楚。
    if (STATUS_RANK[target] <= STATUS_RANK[order.status]) {
      return {
        allowed: false,
        message: `处置单 ${order.code} 当前为「${order.status}」，「${actionName}」属于重复提交，同一张处置单重复提交只算一次`,
      }
    }
    return {
      allowed: false,
      message: `处置单 ${order.code} 当前为「${order.status}」，不能直接跳到「${target}」：状态只能逐级往下流转，跳级拒收`,
    }
  }
  return { allowed: true }
}

function pushEvent(
  order: NcrOrder,
  action: string,
  actor: string,
  department: string,
  to: NcrStatus,
  note: string,
  at: string,
): void {
  const evt: TimelineEvent = {
    at,
    action,
    actor,
    department,
    fromStatus: order.status,
    toStatus: to,
    note,
  }
  order.timeline.push(evt)
  order.heldSince = at.slice(0, 10)
  order.status = to
}

/* ------------------------------------------------------------------ */
/* 1. 判定不合格开单（幂等：同一张处置单重复提交只算一次）             */
/* ------------------------------------------------------------------ */

export type CreateNcrInput = {
  sourceType: string
  sourceNo: string
  batchNo: string
  productName: string
  quantity: string
  nonConformity: string
  foundBy: string
  foundAt: string
  initialDisposition: string
}

export function createNcrOrder(input: CreateNcrInput): NcrActionResult {
  const missing = [
    ['来源类型', input.sourceType],
    ['来源单号', input.sourceNo],
    ['批号', input.batchNo],
    ['产品名称', input.productName],
    ['不合格数量', input.quantity],
    ['不合格描述', input.nonConformity],
    ['判定人', input.foundBy],
    ['判定日期', input.foundAt],
  ].find(([, value]) => !String(value ?? '').trim())
  if (missing) {
    return fail(`${missing[0]}不能为空，请补全后再提交`)
  }

  // 初判建议允许留空（留到质量部评审时再定），但只要填了就必须是合法值。
  let initial: Disposition | '' = ''
  if (input.initialDisposition.trim()) {
    try {
      initial = parseDisposition(input.initialDisposition)
    } catch (error) {
      return fail(error instanceof Error ? error.message : '处置结论非法')
    }
  }

  const orders = allNcrOrders()

  // 幂等键：同一份来源单据 + 同一批号，只允许开出一张处置单。
  const duplicate = orders.find(
    (row) => row.sourceNo.trim() === input.sourceNo.trim() && row.batchNo.trim() === input.batchNo.trim(),
  )
  if (duplicate) {
    return fail(
      `批号 ${input.batchNo}、来源单 ${input.sourceNo} 已开处置单 ${duplicate.code}，同一张处置单重复提交只算一次`,
      true,
    )
  }

  const nextId = orders.reduce((max, row) => Math.max(max, row.id), 0) + 1
  const seq = orders.reduce((max, row) => {
    const tail = Number(row.code.split('-').pop())
    return Number.isNaN(tail) ? max : Math.max(max, tail)
  }, 0) + 1
  const code = `NCR-2026-${pad(seq)}`

  const order: NcrOrder = {
    id: nextId,
    code,
    status: '待评审',
    abnormal: false,
    sourceType: input.sourceType.trim(),
    sourceNo: input.sourceNo.trim(),
    batchNo: input.batchNo.trim(),
    productName: input.productName.trim(),
    quantity: input.quantity.trim(),
    nonConformity: input.nonConformity.trim(),
    foundBy: input.foundBy.trim(),
    foundAt: input.foundAt.trim(),
    disposition: '',
    proposals: [],
    reviewOpinion: '',
    reviewer: '',
    reviewedAt: '',
    executor: '',
    executionRequirement: '',
    reworkBatchNo: '',
    executedAt: '',
    concessionNote: '',
    concessionApprover: '',
    concessionAt: '',
    recheckResult: '',
    recheckInspector: '',
    recheckNote: '',
    recheckedAt: '',
    finalConclusion: '',
    heldSince: input.foundAt.trim(),
    deviationCode: '',
    timeline: [],
  }
  if (initial) {
    order.proposals.push({
      disposition: initial,
      source: '初判建议',
      actor: input.foundBy.trim(),
      department: input.sourceType.trim() || '开单部门',
      at: nowStamp(),
      opinion: '开单时初判建议',
    })
  }
  order.timeline.push({
    at: nowStamp(),
    action: '判定不合格开单',
    actor: input.foundBy.trim(),
    department: input.sourceType.trim(),
    fromStatus: '',
    toStatus: '待评审',
    note: `${input.sourceNo.trim()} 判定不合格${initial ? `，初判建议${initial}` : ''}`,
  })

  persist(orders, order)
  return ok(order, `处置单 ${code} 已开出，当前「待评审」，请质量部出具评审意见`)
}

/* ------------------------------------------------------------------ */
/* 2. 质量部评审分流（评审意见只能质量部出；撞车按优先级裁定）         */
/* ------------------------------------------------------------------ */

export type ReviewInput = {
  department: string
  reviewer: string
  disposition: string
  opinion: string
}

export function submitReview(id: number, input: ReviewInput): NcrActionResult {
  const orders = allNcrOrders()
  const current = orders.find((row) => row.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的处置单`)
  }
  if (input.department.trim() !== QA_DEPARTMENT) {
    return fail(`评审意见只能由${QA_DEPARTMENT}出具，「${input.department.trim() || '（空）'}」无权评审，请质量部登录处理`)
  }
  if (!input.reviewer.trim()) {
    return fail('评审人不能为空')
  }
  if (!input.opinion.trim()) {
    return fail('评审意见不能为空')
  }

  let reviewDisposition: Disposition
  try {
    reviewDisposition = parseDisposition(input.disposition)
  } catch (error) {
    return fail(error instanceof Error ? error.message : '处置结论非法')
  }

  const guard = guardTransition(current, '已评审', '质量部评审')
  if (!guard.allowed) {
    return fail(guard.message)
  }

  // 与初判建议撞车：返工 > 返修 > 让步接收，按优先级高的一版为准。
  const initial = current.proposals.find((item) => item.source === '初判建议')?.disposition
  const winner: Disposition =
    initial && initial !== reviewDisposition
      ? DISPOSITION_PRIORITY[initial] >= DISPOSITION_PRIORITY[reviewDisposition]
        ? initial
        : reviewDisposition
      : reviewDisposition

  const next = cloneOrder(current)
  const stamp = nowStamp()
  next.proposals.push({
    disposition: reviewDisposition,
    source: '评审意见',
    actor: input.reviewer.trim(),
    department: QA_DEPARTMENT,
    at: stamp,
    opinion: input.opinion.trim(),
  })
  next.disposition = winner
  next.reviewOpinion = input.opinion.trim()
  next.reviewer = input.reviewer.trim()
  next.reviewedAt = todayStr()

  let note = `质量部出具评审意见：${reviewDisposition}`
  if (initial && initial !== reviewDisposition) {
    note += `；与初判建议「${initial}」撞车，按优先级（返工>返修>让步接收）以「${winner}」为准`
    if (winner !== reviewDisposition) {
      note += '，评审意见被高优先级版本覆盖'
      next.reviewOpinion = `${input.opinion.trim()}（系统裁定：初判建议「${initial}」优先级更高，最终按${winner}分流）`
    }
    next.abnormal = false
  }
  pushEvent(next, '质量部评审', input.reviewer.trim(), QA_DEPARTMENT, '已评审', note, stamp)

  // 结论形成即反映到偏差处理待办。
  next.deviationCode = next.deviationCode || `DEVI-NCR-${pad(next.id, 4)}`

  persist(orders, next)
  return ok(next, `评审完成，处置单按「${winner}」分流，已同步生成偏差待办 ${next.deviationCode}`)
}

/* ------------------------------------------------------------------ */
/* 3. 返工/返修派工与执行（执行完必须进复检）                          */
/* ------------------------------------------------------------------ */

export function dispatchExecution(id: number, actor: string, department: string): NcrActionResult {
  const orders = allNcrOrders()
  const current = orders.find((row) => row.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的处置单`)
  }
  const target: NcrStatus | null =
    current.disposition === '返工' ? '返工中' : current.disposition === '返修' ? '返修中' : null
  if (!target) {
    return fail(`处置单 ${current.code} 的处置方式为「${current.disposition || '未定'}」，不走返工/返修派工车道`)
  }
  const guard = guardTransition(current, target, '派发执行')
  if (!guard.allowed) {
    return fail(guard.message)
  }
  const next = cloneOrder(current)
  pushEvent(
    next,
    target === '返工中' ? '派发返工' : '派发返修',
    actor.trim() || current.reviewer,
    department.trim() || QA_DEPARTMENT,
    target,
    `${current.disposition}任务已派发`,
    nowStamp(),
  )
  persist(orders, next)
  return ok(next, `已派发${current.disposition}，处置单进入「${target}」`)
}

export type ExecutionInput = {
  executor: string
  requirement: string
  reworkBatchNo: string
  executedAt: string
}

export function completeExecution(id: number, input: ExecutionInput): NcrActionResult {
  const orders = allNcrOrders()
  const current = orders.find((row) => row.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的处置单`)
  }
  if (!input.executor.trim()) {
    return fail('执行人/班组不能为空')
  }
  if (!input.executedAt.trim()) {
    return fail('执行完成日期不能为空')
  }
  if (current.disposition === '返工' && !input.reworkBatchNo.trim()) {
    return fail('返工批次号必须登记：返工批次完成后要凭批次号送检复检')
  }

  const source: NcrStatus | null =
    current.status === '返工中' ? '返工中' : current.status === '返修中' ? '返修中' : null
  if (!source) {
    return fail(`处置单 ${current.code} 当前为「${current.status}」，不在返工/返修执行环节，不能登记执行完成`)
  }
  const guard = guardTransition(current, '待复检', '执行完成送复检')
  if (!guard.allowed) {
    return fail(guard.message)
  }

  const next = cloneOrder(current)
  next.executor = input.executor.trim()
  next.executionRequirement = input.requirement.trim()
  next.reworkBatchNo = input.reworkBatchNo.trim()
  next.executedAt = input.executedAt.trim()
  pushEvent(
    next,
    source === '返工中' ? '返工执行完成' : '返修执行完成',
    input.executor.trim(),
    source === '返工中' ? '生产车间' : '执行车间',
    '待复检',
    `${current.disposition}完成${next.reworkBatchNo ? `，批次 ${next.reworkBatchNo}` : ''}，送 QC 复检`,
    input.executedAt ? `${input.executedAt.trim()} 17:00` : nowStamp(),
  )
  persist(orders, next)
  return ok(next, `${current.disposition}执行完成，处置单进入「待复检」，复检合格前不得办结/放行`)
}

/* ------------------------------------------------------------------ */
/* 4. 让步接收车道（与返工/返修互斥，评审分流时就已经裁定）            */
/* ------------------------------------------------------------------ */

export function enterConcession(id: number, actor: string, note: string): NcrActionResult {
  const orders = allNcrOrders()
  const current = orders.find((row) => row.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的处置单`)
  }
  if (current.disposition !== '让步接收') {
    return fail(`处置单 ${current.code} 裁定为「${current.disposition}」，不能走让步接收车道`)
  }
  const guard = guardTransition(current, '让步待办', '转入让步处理')
  if (!guard.allowed) {
    return fail(guard.message)
  }
  const next = cloneOrder(current)
  next.concessionApprover = actor.trim() || current.reviewer
  next.concessionNote = note.trim()
  next.concessionAt = todayStr()
  pushEvent(
    next,
    '转入让步处理',
    next.concessionApprover,
    QA_DEPARTMENT,
    '让步待办',
    note.trim() ? `让步处理说明：${note.trim()}` : '让步接收备案，随货附偏差说明',
    nowStamp(),
  )
  persist(orders, next)
  return ok(next, '已转入「让步待办」，完成让步放行备案后办结')
}

export function finishConcession(id: number, actor: string): NcrActionResult {
  const orders = allNcrOrders()
  const current = orders.find((row) => row.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的处置单`)
  }
  if (current.disposition !== '让步接收') {
    return fail(
      `处置单 ${current.code} 裁定为「${current.disposition}」，${current.status === '待复检' ? '返工/返修批次必须凭复检结论办结，不能走让步办结' : '不能走让步办结'}`,
    )
  }
  const guard = guardTransition(current, '办结', '让步接收办结')
  if (!guard.allowed) {
    return fail(guard.message)
  }
  const next = cloneOrder(current)
  next.finalConclusion = '让步接收办结，产品按偏差备案放行'
  pushEvent(next, '让步接收办结', actor.trim() || current.concessionApprover, QA_DEPARTMENT, '办结', next.finalConclusion, nowStamp())
  persist(orders, next)
  return ok(next, '让步接收处置单已办结')
}

/* ------------------------------------------------------------------ */
/* 5. 复检（返工/返修批次强制环节；非法结论打回重填）                  */
/* ------------------------------------------------------------------ */

export type RecheckInput = {
  result: string
  inspector: string
  note: string
  recheckedAt: string
}

export function submitRecheck(id: number, input: RecheckInput): NcrActionResult {
  const orders = allNcrOrders()
  const current = orders.find((row) => row.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的处置单`)
  }
  if (!input.inspector.trim()) {
    return fail('复检人不能为空')
  }
  if (!input.recheckedAt.trim()) {
    return fail('复检日期不能为空')
  }
  if (current.disposition !== '返工' && current.disposition !== '返修') {
    return fail(`处置单 ${current.code} 裁定为「${current.disposition || '待分流'}」，没有复检环节，不能提交复检结论`)
  }

  let result: RecheckResult
  try {
    result = parseRecheckResult(input.result)
  } catch (error) {
    return fail(error instanceof Error ? error.message : '复检结论非法')
  }

  const guard = guardTransition(current, '办结', '提交复检结论')
  if (!guard.allowed) {
    // 更明确地告知：复检只在待复检环节收。
    if (current.status !== '待复检') {
      return fail(`处置单 ${current.code} 当前为「${current.status}」，复检结论只在「待复检」环节接收，跳级拒收`)
    }
    return fail(guard.message)
  }

  const next = cloneOrder(current)
  next.recheckResult = result
  next.recheckInspector = input.inspector.trim()
  next.recheckNote = input.note.trim()
  next.recheckedAt = input.recheckedAt.trim()
  if (result === '合格') {
    next.finalConclusion = `${current.disposition}批次复检合格，准予办结放行`
    next.abnormal = false
  } else {
    next.finalConclusion = `${current.disposition}批次复检不合格，不予放行，转报废处理`
    next.abnormal = true
  }
  pushEvent(
    next,
    '提交复检结论',
    input.inspector.trim(),
    'QC化验室',
    '办结',
    `复检${result}：${input.note.trim() || next.finalConclusion}`,
    `${input.recheckedAt.trim()} 16:00`,
  )
  persist(orders, next)
  return ok(
    next,
    result === '合格'
      ? '复检合格，处置单办结，返工/返修批次可放行'
      : '复检不合格，处置单办结但已标记异常，返工/返修批次转报废处理',
  )
}

/* ------------------------------------------------------------------ */
/* 偏差处理待办回写：所有入口看到的结论同源，这里是唯一写入点          */
/* ------------------------------------------------------------------ */

const DEVIATION_KEY = 'deviation'
const NCR_DEVIATION_PREFIX = 'DEVI-NCR-'

/** NCR 待办在偏差台账里占用高位号段，不和手工登记的偏差撞号。 */
function deviationRowId(orderId: number): number {
  return 900000 + orderId
}

export function syncDeviationTodos(): void {
  const rows: EntryRow[] = listRows(DEVIATION_KEY).filter(
    (row) => !String(row['偏差编号']).startsWith(NCR_DEVIATION_PREFIX),
  )
  const holderLabels: Record<string, string> = {
    待评审: '待质量部评审',
    已评审: '待派工/让步处理',
    返工中: '返工执行中',
    返修中: '返修执行中',
    让步待办: '让步放行备案中',
    待复检: '待 QC 复检',
    办结: '处置办结',
  }
  for (const order of allNcrOrders()) {
    if (!order.deviationCode) {
      continue
    }
    const holder = holderFor(order)
    const closed = order.status === '办结'
    rows.push({
      id: deviationRowId(order.id),
      status: closed ? '已关闭' : '待处理',
      pending: !closed,
      abnormal: order.abnormal,
      偏差编号: order.deviationCode,
      偏差类型: '不合格品处置',
      发生工序: order.sourceType,
      偏差描述: `【不合格品处置待办】${order.code}｜${order.productName}｜批号 ${order.batchNo}｜${order.nonConformity}`,
      根本原因: order.reviewOpinion || '质量部尚未出具评审意见',
      纠正措施: `处置方式：${order.disposition || '待评审分流'}（${holderLabels[order.status]}）`,
      责任人: `${holder.name} / ${holder.department}`,
      偏差状态: `${order.disposition || '待分流'}·${order.status}`,
    })
  }
  saveRows(DEVIATION_KEY, rows)
}

/* ------------------------------------------------------------------ */
/* 统计 / 导出 / 重置                                                  */
/* ------------------------------------------------------------------ */

export function ncrOverview(): {
  total: number
  pendingReview: number
  inProgress: number
  waitingRecheck: number
  closed: number
  abnormal: number
  byDisposition: { label: Disposition; count: number }[]
  byStatus: { label: NcrStatus; count: number }[]
} {
  const rows = allNcrOrders()
  const count = (predicate: (row: NcrOrder) => boolean) => rows.filter(predicate).length
  return {
    total: rows.length,
    pendingReview: count((row) => row.status === '待评审'),
    inProgress: count((row) => ['返工中', '返修中', '让步待办'].includes(row.status)),
    waitingRecheck: count((row) => row.status === '待复检'),
    closed: count((row) => row.status === '办结'),
    abnormal: count((row) => row.abnormal),
    byDisposition: (['返工', '返修', '让步接收'] as Disposition[]).map((label) => ({
      label,
      count: count((row) => row.disposition === label),
    })),
    byStatus: (['待评审', '已评审', '返工中', '返修中', '让步待办', '待复检', '办结'] as NcrStatus[]).map(
      (label) => ({ label, count: count((row) => row.status === label) }),
    ),
  }
}

export function exportNcrOrders(): { filename: string; content: string } {
  const header = ['处置单号', '来源类型', '来源单号', '批号', '产品名称', '数量', '不合格描述', '处置方式', '当前状态', '持有人', '所在部门', '滞留天数', '异常', '最终结论', '偏差编号']
  const lines = [header.join(',')]
  for (const row of listNcrOrders()) {
    const holder = holderFor(row)
    const days = heldDays(row)
    lines.push(
      [
        row.code,
        row.sourceType,
        row.sourceNo,
        row.batchNo,
        row.productName,
        row.quantity,
        row.nonConformity,
        row.disposition || '待分流',
        row.status,
        holder.name,
        holder.department,
        days === null ? '已办结' : days,
        row.abnormal ? '是' : '否',
        row.finalConclusion,
        row.deviationCode,
      ]
        .map((cell) => String(cell).replace(/,/g, '，'))
        .join(','),
    )
  }
  return { filename: '不合格品与返工返修台账.csv', content: `\uFEFF${lines.join('\n')}` }
}

export function downloadNcrOrders(): void {
  const { filename, content } = exportNcrOrders()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function resetNcrLedger(): NcrOrder[] {
  const fresh = resetNcrOrders()
  syncDeviationTodos()
  return fresh
}
