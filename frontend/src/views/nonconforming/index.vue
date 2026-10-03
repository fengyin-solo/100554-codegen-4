<template>
  <section class="page ncr-page">
    <header class="page-head">
      <div>
        <h2>不合格品与返工返修台账</h2>
        <p class="page-desc">
          一张处置单从判定不合格一路走到办结：按处置方式分流，评审意见由质量部出具，返工/返修批次强制复检；
          状态只往下流转，跳级拒收；同一张处置单重复提交只算一次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">判定不合格开单</button>
        <button class="btn" type="button" @click="exportRows">导出台账</button>
        <button class="btn ghost" type="button" @click="resetAll">重置示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card"><span class="stat-label">处置单总量</span><strong class="stat-value">{{ stats.total }}</strong></article>
      <article class="stat-card"><span class="stat-label">待质量部评审</span><strong class="stat-value">{{ stats.pendingReview }}</strong></article>
      <article class="stat-card"><span class="stat-label">执行中（返工/返修/让步）</span><strong class="stat-value">{{ stats.inProgress }}</strong></article>
      <article class="stat-card"><span class="stat-label">待复检批次</span><strong class="stat-value">{{ stats.waitingRecheck }}</strong></article>
      <article class="stat-card"><span class="stat-label">已办结</span><strong class="stat-value">{{ stats.closed }}</strong></article>
      <article class="stat-card"><span class="stat-label">异常（复检不合格等）</span><strong class="stat-value">{{ stats.abnormal }}</strong></article>
    </div>

    <p class="status-legend">
      <span v-for="item in stats.byStatus" :key="item.label" class="legend-item">{{ item.label }}：{{ item.count }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关键词（单号/批号/产品/不合格项）</span>
        <input v-model="filters.keyword" placeholder="按关键词检索" />
      </label>
      <label class="filter-item">
        <span>当前状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option v-for="s in ALL_STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>处置方式</span>
        <select v-model="filters.disposition">
          <option value="">全部</option>
          <option v-for="d in DISPOSITIONS" :key="d" :value="d">{{ d }}</option>
          <option value="待分流">待分流</option>
        </select>
      </label>
      <label class="filter-item">
        <span>只看异常</span>
        <select v-model="filters.abnormal">
          <option value="">否</option>
          <option value="是">是</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>处置单号</th>
          <th>批号 / 产品</th>
          <th>不合格项</th>
          <th>处置方式</th>
          <th>当前状态</th>
          <th>停在谁手里</th>
          <th>滞留</th>
          <th>偏差待办</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ 'row-abnormal': row.abnormal }">
          <td>
            <button class="link" type="button" @click="openDetail(row.id)">{{ row.code }}</button>
            <span v-if="row.abnormal" class="tag tag-abnormal">异常</span>
          </td>
          <td>{{ row.batchNo }}<br /><span class="muted">{{ row.productName }} · {{ row.quantity }}</span></td>
          <td class="cell-narrow">{{ row.nonConformity }}</td>
          <td>
            <span :class="['tag', dispositionTag(row.disposition)]">{{ row.disposition || '待分流' }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td>
            {{ holderOf(row).name }}
            <br /><span class="muted">{{ holderOf(row).department }}</span>
          </td>
          <td>
            <span v-if="heldDaysOf(row) === null" class="muted">—</span>
            <span v-else :class="{ 'days-overdue': (heldDaysOf(row) ?? 0) >= 3 }">
              {{ heldDaysOf(row) }} 天
            </span>
          </td>
          <td>
            <RouterLink v-if="row.deviationCode" class="link" to="/deviation">{{ row.deviationCode }}</RouterLink>
            <span v-else class="muted">评审后生成</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row.id)">办理 / 详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="9" class="empty-state">没有命中的处置单，可点右上角「判定不合格开单」</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 张处置单 · 结论同步到「偏差处理」待办，两处同源</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>

    <!-- ===================== 开单弹窗 ===================== -->
    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3>判定不合格开单</h3>
        <p class="muted small">同一份来源单 + 同一批号重复提交只算一次，不会开出第二张单。</p>
        <div class="form-grid">
          <label><span>来源类型 *</span>
            <select v-model="createForm.sourceType">
              <option value="">请选择</option>
              <option v-for="t in SOURCE_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label><span>来源单号 *</span><input v-model="createForm.sourceNo" placeholder="如 QC-20261003-01" /></label>
          <label><span>批号 *</span><input v-model="createForm.batchNo" /></label>
          <label><span>产品名称 *</span><input v-model="createForm.productName" /></label>
          <label><span>不合格数量 *</span><input v-model="createForm.quantity" placeholder="如 5000 瓶" /></label>
          <label><span>判定日期 *</span><input v-model="createForm.foundAt" type="date" /></label>
          <label><span>判定人 *</span><input v-model="createForm.foundBy" /></label>
          <label>
            <span>初判建议处置方式（可空）</span>
            <select v-model="createForm.initialDisposition">
              <option value="">待质量部评审定</option>
              <option v-for="d in DISPOSITIONS" :key="d" :value="d">{{ d }}</option>
              <option value="特殊放行（非法值示例）">特殊放行（非法值示例）</option>
            </select>
          </label>
          <label class="full"><span>不合格描述 *</span><textarea v-model="createForm.nonConformity" rows="2" /></label>
        </div>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交开单</button>
        </div>
      </div>
    </div>

    <!-- ===================== 详情/办理抽屉 ===================== -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <div>
            <h3>{{ detail.code }}
              <span :class="['tag', dispositionTag(detail.disposition)]">{{ detail.disposition || '待分流' }}</span>
              <span v-if="detail.abnormal" class="tag tag-abnormal">异常</span>
            </h3>
            <p class="muted small">{{ detail.productName }} · 批号 {{ detail.batchNo }} · {{ detail.quantity }}</p>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <section class="detail-section">
          <h4>判定信息</h4>
          <p class="kv"><b>来源：</b>{{ detail.sourceType }} {{ detail.sourceNo }}　<b>判定人：</b>{{ detail.foundBy }}（{{ detail.foundAt }}）</p>
          <p class="kv"><b>不合格项：</b>{{ detail.nonConformity }}</p>
          <p class="kv"><b>当前持有人：</b>{{ detailHolder.name }} / {{ detailHolder.department }}</p>
          <p class="kv"><b>偏差待办：</b>{{ detail.deviationCode || '评审出具后同步到偏差处理待办' }}</p>
        </section>

        <!-- 质量部评审 -->
        <section v-if="detail.status === '待评审'" class="detail-section">
          <h4>质量部评审（评审意见只能由质量部出具）</h4>
          <p v-if="initialProposal" class="kv">
            初判建议：<span :class="['tag', dispositionTag(initialProposal.disposition)]">{{ initialProposal.disposition }}</span>
            由 {{ initialProposal.actor }}（{{ initialProposal.department }}）提出
          </p>
          <div class="form-grid">
            <label><span>出具部门 *</span>
              <select v-model="reviewForm.department">
                <option v-for="d in DEPARTMENTS" :key="d" :value="d">{{ d }}</option>
              </select>
            </label>
            <label><span>评审人 *</span><input v-model="reviewForm.reviewer" placeholder="质量部评审人" /></label>
            <label class="full"><span>评审处置结论 *</span>
              <select v-model="reviewForm.disposition">
                <option value="">请选择</option>
                <option v-for="d in DISPOSITIONS" :key="d" :value="d">{{ d }}</option>
                <option value="直接报废（非法值示例）">直接报废（非法值示例）</option>
              </select>
            </label>
            <label class="full"><span>评审意见 *</span><textarea v-model="reviewForm.opinion" rows="2" /></label>
          </div>
          <p v-if="reviewError" class="error-text">{{ reviewError }}</p>
          <button class="btn primary" type="button" @click="submitReview">提交评审意见并分流</button>
          <p class="muted small">处置方式撞车时按优先级裁定：返工 &gt; 返修 &gt; 让步接收。</p>
        </section>

        <!-- 已评审：派工 或 让步处理 -->
        <section v-if="detail.status === '已评审'" class="detail-section">
          <h4>评审结论与分流</h4>
          <p class="kv"><b>最终处置方式：</b><span :class="['tag', dispositionTag(detail.disposition)]">{{ detail.disposition }}</span>　<b>评审人：</b>{{ detail.reviewer }}（{{ detail.reviewedAt }}）</p>
          <p class="kv"><b>评审意见：</b>{{ detail.reviewOpinion }}</p>
          <div v-if="detail.disposition === '让步接收'" class="form-grid">
            <label class="full"><span>让步放行备案说明</span><textarea v-model="concessionForm.note" rows="2" placeholder="随货附偏差说明、客户知会等" /></label>
            <label><span>办理人</span><input v-model="concessionForm.actor" /></label>
          </div>
          <p v-if="laneError" class="error-text">{{ laneError }}</p>
          <button v-if="detail.disposition === '返工' || detail.disposition === '返修'" class="btn primary" type="button" @click="dispatchExec">
            派发{{ detail.disposition }}（进入{{ detail.disposition }}中）
          </button>
          <button v-else-if="detail.disposition === '让步接收'" class="btn primary" type="button" @click="enterConcession">
            转入让步处理
          </button>
        </section>

        <!-- 返工/返修执行 -->
        <section v-if="detail.status === '返工中' || detail.status === '返修中'" class="detail-section">
          <h4>{{ detail.disposition }}执行（完成后必须送复检）</h4>
          <p class="kv"><b>执行要求（评审）：</b>{{ detail.executionRequirement || '—' }}</p>
          <div class="form-grid">
            <label><span>执行班组/人 *</span><input v-model="execForm.executor" placeholder="如 生产二车间·冯班长" /></label>
            <label v-if="detail.disposition === '返工'"><span>返工批次号 *</span><input v-model="execForm.reworkBatchNo" placeholder="返工批次凭号送检" /></label>
            <label v-else><span>返修批次号</span><input v-model="execForm.reworkBatchNo" /></label>
            <label><span>完成日期 *</span><input v-model="execForm.executedAt" type="date" /></label>
            <label class="full"><span>执行说明</span><textarea v-model="execForm.requirement" rows="2" /></label>
          </div>
          <p v-if="laneError" class="error-text">{{ laneError }}</p>
          <button class="btn primary" type="button" @click="completeExec">{{ detail.disposition }}执行完成，送 QC 复检</button>
        </section>

        <!-- 让步待办：办结 -->
        <section v-if="detail.status === '让步待办'" class="detail-section">
          <h4>让步接收办结</h4>
          <p class="kv"><b>备案说明：</b>{{ detail.concessionNote || '随货附偏差说明' }}</p>
          <p v-if="laneError" class="error-text">{{ laneError }}</p>
          <button class="btn primary" type="button" @click="finishConcession">让步接收办结</button>
        </section>

        <!-- 待复检 -->
        <section v-if="detail.status === '待复检'" class="detail-section">
          <h4>返工/返修批次复检</h4>
          <p class="kv">
            <b>{{ detail.disposition }}批次：</b>{{ detail.reworkBatchNo || '—' }}
            <b>执行：</b>{{ detail.executor }}（{{ detail.executedAt }}）
          </p>
          <div class="form-grid">
            <label><span>复检结论 *</span>
              <select v-model="recheckForm.result">
                <option value="">请选择</option>
                <option value="合格">合格</option>
                <option value="不合格">不合格（转报废，单标记异常）</option>
                <option value="让步放行（非法值示例）">让步放行（非法值示例）</option>
              </select>
            </label>
            <label><span>复检人 *</span><input v-model="recheckForm.inspector" /></label>
            <label><span>复检日期 *</span><input v-model="recheckForm.recheckedAt" type="date" /></label>
            <label class="full"><span>复检备注</span><textarea v-model="recheckForm.note" rows="2" /></label>
          </div>
          <p v-if="laneError" class="error-text">{{ laneError }}</p>
          <button class="btn primary" type="button" @click="submitRecheck">提交复检结论并办结</button>
        </section>

        <section v-if="detail.status === '办结'" class="detail-section">
          <h4>办结结论</h4>
          <p class="kv">{{ detail.finalConclusion }}</p>
          <p class="kv"><b>复检结论：</b>{{ detail.recheckResult || '让步接收无复检环节' }}　<b>复检人：</b>{{ detail.recheckInspector || '—' }}</p>
          <p class="muted small">处置单已办结，状态不能再往下走，任何重复提交都会被拒收。</p>
        </section>

        <!-- 处置主张留痕 -->
        <section class="detail-section">
          <h4>处置主张（各入口看到的是同一套结论）</h4>
          <table class="data-table inner-table">
            <thead><tr><th>来源</th><th>处置结论</th><th>提出人/部门</th><th>时间</th><th>意见</th></tr></thead>
            <tbody>
              <tr v-for="(p, idx) in detail.proposals" :key="idx">
                <td>{{ p.source }}</td>
                <td><span :class="['tag', dispositionTag(p.disposition)]">{{ p.disposition }}</span></td>
                <td>{{ p.actor }} / {{ p.department }}</td>
                <td>{{ p.at }}</td>
                <td>{{ p.opinion }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 流转时间线 -->
        <section class="detail-section">
          <h4>流转时间线</h4>
          <ol class="timeline">
            <li v-for="(evt, idx) in detail.timeline" :key="idx">
              <div class="timeline-dot"></div>
              <div>
                <p class="timeline-title">{{ evt.action }}：{{ evt.fromStatus || '开单' }} → {{ evt.toStatus }}</p>
                <p class="muted small">{{ evt.at }} · {{ evt.actor }}（{{ evt.department }}）</p>
                <p v-if="evt.note" class="small">{{ evt.note }}</p>
              </div>
            </li>
          </ol>
        </section>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  completeExecution as apiCompleteExecution,
  createNcrOrder,
  dispatchExecution as apiDispatchExecution,
  downloadNcrOrders,
  enterConcession as apiEnterConcession,
  finishConcession as apiFinishConcession,
  getNcrOrder,
  heldDays,
  holderFor,
  listNcrOrders,
  ncrOverview,
  resetNcrLedger,
  submitRecheck as apiSubmitRecheck,
  submitReview as apiSubmitReview,
  todayStr,
} from '@/api/ncr-service'
import { DISPOSITIONS, NCR_STATUSES, QA_DEPARTMENT } from '@/data/ncr-types'
import type { Disposition, NcrOrder } from '@/data/ncr-types'

const ALL_STATUSES = [...NCR_STATUSES]
const SOURCE_TYPES = ['成品检验', '过程检验', '中间站退库', '仓储存放复检', '退货抽查']
const DEPARTMENTS = [QA_DEPARTMENT, 'QC化验室', '生产一车间', '生产二车间', '包装车间', '销售部']

const rows = ref<NcrOrder[]>([])
const stats = ref(ncrOverview())
const errorMessage = ref('')
const infoMessage = ref('')

const filters = reactive({ keyword: '', status: '', disposition: '', abnormal: '' })

const showCreate = ref(false)
const detail = ref<NcrOrder | null>(null)

const createForm = reactive({
  sourceType: '',
  sourceNo: '',
  batchNo: '',
  productName: '',
  quantity: '',
  nonConformity: '',
  foundBy: '',
  foundAt: todayStr(),
  initialDisposition: '',
})
const createError = ref('')

const reviewForm = reactive({ department: QA_DEPARTMENT, reviewer: '', disposition: '', opinion: '' })
const reviewError = ref('')
const execForm = reactive({ executor: '', requirement: '', reworkBatchNo: '', executedAt: todayStr() })
const recheckForm = reactive({ result: '', inspector: '', note: '', recheckedAt: todayStr() })
const concessionForm = reactive({ actor: '', note: '' })
const laneError = ref('')

const initialProposal = computed(() =>
  detail.value?.proposals.find((item) => item.source === '初判建议') ?? null,
)
const detailHolder = computed(() => (detail.value ? holderFor(detail.value) : { name: '', department: '' }))

function holderOf(row: NcrOrder) {
  return holderFor(row)
}
function heldDaysOf(row: NcrOrder) {
  return heldDays(row)
}
function dispositionTag(value: Disposition | ''): string {
  if (value === '返工') return 'tag-rework'
  if (value === '返修') return 'tag-repair'
  if (value === '让步接收') return 'tag-concession'
  return 'tag-pending'
}

function flash(message: string, okFlag: boolean) {
  if (okFlag) {
    infoMessage.value = message
    errorMessage.value = ''
  } else {
    errorMessage.value = message
    infoMessage.value = ''
  }
  window.setTimeout(() => {
    infoMessage.value = ''
    errorMessage.value = ''
  }, 5000)
}

function reload() {
  rows.value = listNcrOrders(filters)
  stats.value = ncrOverview()
  if (detail.value) {
    detail.value = getNcrOrder(detail.value.id) ?? null
  }
}

function resetFilters() {
  filters.keyword = ''
  filters.status = ''
  filters.disposition = ''
  filters.abnormal = ''
  reload()
}

function exportRows() {
  downloadNcrOrders()
}

function resetAll() {
  resetNcrLedger()
  detail.value = null
  reload()
  flash('台账与偏差待办已重置为示例数据', true)
}

/* ---------------- 开单 ---------------- */

function openCreate() {
  createError.value = ''
  Object.assign(createForm, {
    sourceType: '',
    sourceNo: '',
    batchNo: '',
    productName: '',
    quantity: '',
    nonConformity: '',
    foundBy: '',
    foundAt: todayStr(),
    initialDisposition: '',
  })
  showCreate.value = true
}
function closeCreate() {
  showCreate.value = false
}
function submitCreate() {
  const result = createNcrOrder({ ...createForm })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  showCreate.value = false
  reload()
  flash(result.message, true)
}

/* ---------------- 详情与办理 ---------------- */

function openDetail(id: number) {
  const found = getNcrOrder(id)
  if (!found) {
    return
  }
  detail.value = found
  reviewError.value = ''
  laneError.value = ''
  reviewForm.department = QA_DEPARTMENT
  reviewForm.reviewer = found.reviewer || ''
  reviewForm.disposition = found.proposals.find((p) => p.source === '评审意见')?.disposition || ''
  reviewForm.opinion = ''
  execForm.executor = found.executor || ''
  execForm.requirement = found.executionRequirement || ''
  execForm.reworkBatchNo = found.reworkBatchNo || ''
  execForm.executedAt = todayStr()
  recheckForm.result = ''
  recheckForm.inspector = found.recheckInspector || ''
  recheckForm.note = ''
  recheckForm.recheckedAt = todayStr()
  concessionForm.actor = found.reviewer || ''
  concessionForm.note = found.concessionNote || ''
}
function closeDetail() {
  detail.value = null
}

function afterAction(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    laneError.value = result.message
    reviewError.value = result.message
    return
  }
    reviewError.value = ''
    laneError.value = ''
    reload()
    flash(result.message, true)
}

function submitReview() {
  if (!detail.value) return
  const result = apiSubmitReview(detail.value.id, { ...reviewForm })
  afterAction(result)
}

function dispatchExec() {
  if (!detail.value) return
  const result = apiDispatchExecution(detail.value.id, detail.value.reviewer, QA_DEPARTMENT)
  afterAction(result)
}

function completeExec() {
  if (!detail.value) return
  const result = apiCompleteExecution(detail.value.id, { ...execForm })
  afterAction(result)
}

function enterConcession() {
  if (!detail.value) return
  const result = apiEnterConcession(detail.value.id, concessionForm.actor, concessionForm.note)
  afterAction(result)
}

function finishConcession() {
  if (!detail.value) return
  const result = apiFinishConcession(detail.value.id, concessionForm.actor)
  afterAction(result)
}

function submitRecheck() {
  if (!detail.value) return
  const result = apiSubmitRecheck(detail.value.id, { ...recheckForm })
  afterAction(result)
}

onMounted(() => {
  reload()
})
</script>

<style scoped>
.ncr-page .muted { color: var(--muted); }
.ncr-page .small { font-size: 12px; }
.ncr-page .cell-narrow { max-width: 240px; }
.ncr-page .row-abnormal { background: #fef3f2; }

.tag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; background: #eef2f7; color: #334155; white-space: nowrap; }
.tag-rework { background: #e0ecff; color: #1d4ed8; }
.tag-repair { background: #e6f4ea; color: #1a7f37; }
.tag-concession { background: #fdf0da; color: #b45309; }
.tag-pending { background: #eef2f7; color: #64748b; }
.tag-abnormal { background: #fee4e2; color: #b42318; margin-left: 4px; }
.days-overdue { color: #b42318; font-weight: 600; }
.info-text { color: #1a7f37; }

.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: #fff; border-radius: 10px; padding: 20px; width: 760px; max-width: 92vw; max-height: 88vh; overflow: auto; }
.modal h3 { margin: 0 0 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }

.drawer-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 40; display: flex; justify-content: flex-end; }
.drawer { width: 720px; max-width: 94vw; background: #fff; height: 100%; overflow: auto; padding: 18px 20px 40px; }
.drawer-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 12px; }
.drawer-head h3 { margin: 0 0 4px; }
.detail-section { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.detail-section h4 { margin: 0 0 8px; font-size: 14px; }
.kv { margin: 4px 0; font-size: 13px; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.form-grid label.full { grid-column: 1 / -1; }
.form-grid input, .form-grid select, .form-grid textarea { font-size: 13px; color: #1f2937; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }

.inner-table th, .inner-table td { font-size: 12px; padding: 6px 8px; }

.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { display: flex; gap: 10px; position: relative; padding-bottom: 14px; }
.timeline li::before { content: ''; position: absolute; left: 4px; top: 12px; bottom: 0; width: 2px; background: var(--border); }
.timeline li:last-child::before { display: none; }
.timeline-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--brand); margin-top: 5px; flex: none; z-index: 1; }
.timeline-title { margin: 0; font-size: 13px; font-weight: 600; }
</style>
