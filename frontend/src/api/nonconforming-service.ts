import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 不合格品与返工返修台账的专用服务：处置单状态机、幂等提交、批次优先级裁决、
// 办结结论校验、偏差待办联动都收在这里，页面只负责收集输入和展示结果。
const KEY = 'nonconforming'
// 办结结论要落到偏差处理模块的待办里；两个模块读写同一份本地库，各入口看到的自然是同一套。
const DEVIATION_KEY = 'deviation'

// 处置方式优先级：返工返修 > 让步接收 > 拒收报废。
// 让步接收与返工返修撞上时，按优先级高的那一版为准。
const DISPOSITION_PRIORITY: Record<string, number> = {
  返工返修: 3,
  让步接收: 2,
  拒收报废: 1,
}

// 每种处置方式的合法流转路线：状态只能沿路线往下走一格，跳级拒收。
// 返工返修批次要复检，所以多一站「待复检」。
const ROUTES: Record<string, string[]> = {
  返工返修: ['待评审', '处置中', '待复检', '已办结'],
  让步接收: ['待评审', '处置中', '已办结'],
  拒收报废: ['待评审', '处置中', '已办结'],
}

// 办结时允许填的处置结论，按有效处置方式限定；填成别的值一律打回重填。
const LEGAL_CONCLUSIONS: Record<string, string[]> = {
  返工返修: ['返工复检合格', '拒收报废'],
  让步接收: ['让步接收'],
  拒收报废: ['拒收报废'],
}

const REVIEW_DEPT = '质量部'
const STATUS_REVIEW = '待评审'
const STATUS_FINAL = '已办结'
const REINSPECT_RESULTS = ['合格', '不合格']

export const DISPOSITION_OPTIONS = Object.keys(DISPOSITION_PRIORITY)

function rowsOf(key: string): EntryRow[] {
  return listRows(key).map((row) => ({ ...row }))
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 该单当前生效的处置方式：批次有效处置优先，其次评审定的处置方式。 */
export function effectiveDispositionOf(row: EntryRow): string {
  const batchValue = String(row['批次有效处置'] ?? '').trim()
  if (batchValue && batchValue !== '待分流') {
    return batchValue
  }
  return String(row['处置方式'] ?? '').trim()
}

function routeOf(row: EntryRow): string[] {
  // 待评审时处置方式未定，先走所有路线共有的前两站。
  return ROUTES[effectiveDispositionOf(row)] ?? [STATUS_REVIEW, '处置中']
}

/** 当前状态沿路线往下走的下一站；已到办结则返回 null。 */
export function nextStatusOf(row: EntryRow): string | null {
  const route = routeOf(row)
  const index = route.indexOf(String(row.status))
  if (index < 0 || index + 1 >= route.length) {
    return null
  }
  return route[index + 1]
}

/** 当前这张单允许填的处置结论；返工批次复检不合格时只能按拒收报废办结。 */
export function legalConclusionsFor(row: EntryRow): string[] {
  const effective = effectiveDispositionOf(row)
  if (effective === '返工返修' && String(row['复检结果']) === '不合格') {
    return ['拒收报废']
  }
  return LEGAL_CONCLUSIONS[effective] ?? []
}

// 同一张处置单重复提交只算一次：已经在目标状态或更后面时，按幂等成功返回，不再重复写。
function idempotent(row: EntryRow, action: string): ActionResult {
  return { ok: true, message: `处置单 ${row['处置单号']} 已${action}过，重复提交只算一次` }
}

function notFound(id: number): ActionResult {
  return { ok: false, message: `没有找到编号为 ${id} 的处置单` }
}

// 同批号可能开到多张处置单：重算该批的批次有效处置（优先级最高的那一版），写回每一行。
function refreshBatchEffective(rows: EntryRow[], batch: string): string {
  const inBatch = rows.filter((row) => String(row['产品批号']) === batch)
  const candidates = inBatch
    .map((row) => String(row['处置方式']))
    .filter((value) => DISPOSITION_PRIORITY[value] !== undefined)
  const effective = candidates.length
    ? candidates.reduce((a, b) => (DISPOSITION_PRIORITY[a] >= DISPOSITION_PRIORITY[b] ? a : b))
    : '待分流'
  for (const row of inBatch) {
    row['批次有效处置'] = effective
  }
  return effective
}

export type CreateInput = {
  处置单号: string
  产品批号: string
  不合格项目: string
  不合格数量: string
}

/** 判定不合格后开单，初始状态「待评审」。同一处置单号重复提交只算一次。 */
export function createDisposition(input: CreateInput): ActionResult {
  const code = input.处置单号.trim()
  const batch = input.产品批号.trim()
  const item = input.不合格项目.trim()
  const quantity = Number(input.不合格数量)
  if (!code || !batch || !item) {
    return { ok: false, message: '处置单号、产品批号、不合格项目都要填' }
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, message: '不合格数量要填大于 0 的数字' }
  }
  const rows = rowsOf(KEY)
  if (rows.some((row) => String(row['处置单号']) === code)) {
    return { ok: true, message: `处置单 ${code} 已登记，重复提交只算一次` }
  }
  rows.push({
    id: nextId(rows),
    status: STATUS_REVIEW,
    pending: true,
    abnormal: false,
    处置单号: code,
    产品批号: batch,
    不合格项目: item,
    不合格数量: quantity,
    处置方式: '待分流',
    评审意见: '',
    复检结果: '',
    处置结论: '',
    批次有效处置: '待分流',
    评审部门: '',
  })
  saveRows(KEY, rows)
  return { ok: true, message: `处置单 ${code} 已登记：判定不合格，待质量部评审` }
}

/** 质量部评审：出具评审意见并定处置方式，处置单按处置方式分流到「处置中」。 */
export function reviewDisposition(id: number, disposition: string, opinion: string): ActionResult {
  const rows = rowsOf(KEY)
  const row = findRow(rows, id)
  if (!row) {
    return notFound(id)
  }
  if (String(row.status) !== STATUS_REVIEW) {
    return idempotent(row, '评审')
  }
  const target = disposition.trim()
  if (DISPOSITION_PRIORITY[target] === undefined) {
    return {
      ok: false,
      message: `处置方式「${target}」非法，打回重填；合法值：${DISPOSITION_OPTIONS.join('、')}`,
    }
  }
  const text = opinion.trim()
  if (!text) {
    return { ok: false, message: '评审意见不能为空，评审意见一律由质量部出具' }
  }
  const batch = String(row['产品批号'])
  const clash = rows.find(
    (other) =>
      Number(other.id) !== id &&
      String(other['产品批号']) === batch &&
      DISPOSITION_PRIORITY[String(other['处置方式'])] !== undefined &&
      String(other['处置方式']) !== target,
  )
  row['处置方式'] = target
  row['评审意见'] = `${REVIEW_DEPT}：${text}`
  row['评审部门'] = REVIEW_DEPT
  row.status = '处置中'
  const effective = refreshBatchEffective(rows, batch)
  saveRows(KEY, rows)
  const clashNote = clash
    ? `；与 ${clash['处置单号']} 的「${clash['处置方式']}」撞上，按优先级以「${effective}」为准`
    : ''
  return { ok: true, message: `处置单 ${row['处置单号']} 已经${REVIEW_DEPT}评审，按「${target}」分流${clashNote}` }
}

/** 提交复检：仅返工返修路线的「处置中」可走到「待复检」。 */
export function submitReinspect(id: number): ActionResult {
  const rows = rowsOf(KEY)
  const row = findRow(rows, id)
  if (!row) {
    return notFound(id)
  }
  if (String(row.status) === '待复检') {
    return idempotent(row, '提交复检')
  }
  if (String(row.status) === STATUS_REVIEW) {
    return { ok: false, message: `处置单 ${row['处置单号']} 尚未评审，跳级拒收` }
  }
  if (effectiveDispositionOf(row) !== '返工返修') {
    return { ok: false, message: `处置单 ${row['处置单号']} 按「${effectiveDispositionOf(row)}」处置，无需复检` }
  }
  if (nextStatusOf(row) !== '待复检') {
    return { ok: false, message: `处置单 ${row['处置单号']} 当前「${row.status}」，不能提交复检，跳级拒收` }
  }
  row.status = '待复检'
  saveRows(KEY, rows)
  return { ok: true, message: `处置单 ${row['处置单号']} 已提交复检，返工批次要复检合格才能办结` }
}

/** 登记复检结果：停留在「待复检」，只更新复检结果字段。 */
export function recordReinspect(id: number, result: string): ActionResult {
  const rows = rowsOf(KEY)
  const row = findRow(rows, id)
  if (!row) {
    return notFound(id)
  }
  const value = result.trim()
  if (!REINSPECT_RESULTS.includes(value)) {
    return { ok: false, message: `复检结果「${value}」非法，打回重填；合法值：${REINSPECT_RESULTS.join('、')}` }
  }
  if (String(row.status) !== '待复检') {
    return { ok: false, message: `处置单 ${row['处置单号']} 当前「${row.status}」，不在待复检状态` }
  }
  if (String(row['复检结果']) === value) {
    return idempotent(row, '登记复检结果')
  }
  row['复检结果'] = value
  saveRows(KEY, rows)
  return { ok: true, message: `处置单 ${row['处置单号']} 复检结果已登记：${value}` }
}

/** 办结处置单：结论非法打回重填；办结后结论同步到偏差处理待办。 */
export function closeDisposition(id: number, conclusion: string): ActionResult {
  const rows = rowsOf(KEY)
  const row = findRow(rows, id)
  if (!row) {
    return notFound(id)
  }
  if (String(row.status) === STATUS_FINAL) {
    return idempotent(row, '办结')
  }
  if (nextStatusOf(row) !== STATUS_FINAL) {
    return {
      ok: false,
      message: `处置单 ${row['处置单号']} 当前「${row.status}」，下一步不是办结；状态只能往下走一格，跳级拒收`,
    }
  }
  if (effectiveDispositionOf(row) === '返工返修' && !String(row['复检结果'])) {
    return { ok: false, message: '返工批次要先登记复检结果才能办结' }
  }
  const value = conclusion.trim()
  const legal = legalConclusionsFor(row)
  if (!legal.includes(value)) {
    return { ok: false, message: `处置结论「${value || '空'}」非法，打回重填；当前合法值：${legal.join('、')}` }
  }
  row['处置结论'] = value
  row.status = STATUS_FINAL
  row.pending = false
  row.abnormal = value === '拒收报废'
  saveRows(KEY, rows)
  ensureDeviationTodo(row)
  return { ok: true, message: `处置单 ${row['处置单号']} 已办结，结论「${value}」已反映到偏差处理待办` }
}

// 办结一单就在偏差处理里落一条待办；按偏差编号去重，重复触发也只算一次。
function ensureDeviationTodo(row: EntryRow): void {
  const code = `DEVI-${row['处置单号']}`
  const rows = rowsOf(DEVIATION_KEY)
  if (rows.some((item) => String(item['偏差编号']) === code)) {
    return
  }
  rows.push({
    id: nextId(rows),
    status: '待处理',
    pending: true,
    abnormal: row['处置结论'] === '拒收报废',
    偏差编号: code,
    偏差类型: '不合格品处置',
    发生工序: '质量处置',
    偏差描述: `${row['处置单号']}办结：${row['处置结论']}`,
    根本原因: '',
    纠正措施: String(row['批次有效处置'] ?? row['处置方式']),
    责任人: REVIEW_DEPT,
    偏差状态: '待处理',
  })
  saveRows(DEVIATION_KEY, rows)
}

/** 对账：所有已办结处置单都要在偏差处理里有一条待办，缺了补上；重复跑也只算一次。 */
export function reconcileDeviationTodos(): number {
  const closed = rowsOf(KEY).filter((row) => String(row.status) === STATUS_FINAL)
  const before = listRows(DEVIATION_KEY).length
  for (const row of closed) {
    ensureDeviationTodo(row)
  }
  return listRows(DEVIATION_KEY).length - before
}
