<template>
  <section class="page" data-module="nonconforming">
    <header class="page-head">
      <div>
        <h2>不合格品与返工返修台账</h2>
        <p class="page-desc">一张处置单从判定不合格一路走到办结：质量部评审定处置方式，按方式分流，返工批次要复检，办结结论同步到偏差处理待办。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记处置单</button>
        <button class="btn" type="button" @click="exportRows">导出处置单清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p class="rule-hint">
      处置优先级：返工返修 ＞ 让步接收 ＞ 拒收报废。同批号多张处置单撞上时，按优先级高的那一版为准（见「批次有效处置」列）；状态只能往下流转，跳级拒收；同一处置单重复提交只算一次。
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!rowActions(row).length">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无处置单，可先登记处置单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 张处置单</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialog" class="modal-mask" @click.self="closeDialog">
      <div class="modal-box">
        <h3>{{ dialogTitle }}</h3>

        <template v-if="dialog === 'create'">
          <label class="form-item">
            <span>处置单号</span>
            <input v-model="form.处置单号" placeholder="如 NCR-0005" />
          </label>
          <label class="form-item">
            <span>产品批号</span>
            <input v-model="form.产品批号" placeholder="如 PN-2026-092" />
          </label>
          <label class="form-item">
            <span>不合格项目</span>
            <input v-model="form.不合格项目" placeholder="如 含量均匀度超标" />
          </label>
          <label class="form-item">
            <span>不合格数量</span>
            <input v-model="form.不合格数量" placeholder="大于 0 的数字" />
          </label>
        </template>

        <template v-else-if="dialog === 'review'">
          <label class="form-item">
            <span>评审部门</span>
            <input value="质量部" disabled />
          </label>
          <label class="form-item">
            <span>处置方式（按此分流）</span>
            <select v-model="form.处置方式">
              <option v-for="option in dispositionOptions" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label class="form-item">
            <span>评审意见</span>
            <textarea v-model="form.评审意见" rows="3" placeholder="质量部评审意见"></textarea>
          </label>
        </template>

        <template v-else-if="dialog === 'reinspect'">
          <label class="form-item">
            <span>复检结果</span>
            <select v-model="form.复检结果">
              <option value="合格">合格</option>
              <option value="不合格">不合格</option>
            </select>
          </label>
        </template>

        <template v-else-if="dialog === 'close'">
          <p class="rule-hint">
            有效处置「{{ activeEffective }}」<template v-if="activeRow && activeRow['复检结果']">，复检结果「{{ activeRow['复检结果'] }}」</template>；合法结论：{{ legalHints.join('、') }}
          </p>
          <label class="form-item">
            <span>处置结论</span>
            <input v-model="form.处置结论" :placeholder="`合法值：${legalHints.join('、')}`" />
          </label>
        </template>

        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="submitDialog">提交</button>
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  DISPOSITION_OPTIONS,
  closeDisposition,
  createDisposition,
  effectiveDispositionOf,
  legalConclusionsFor,
  nextStatusOf,
  reconcileDeviationTodos,
  recordReinspect,
  reviewDisposition,
  submitReinspect,
} from '@/api/nonconforming-service'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('nonconforming')
const columns = [...meta.fields, '批次有效处置']
const statuses = meta.statuses
const filterFields = ['处置单号', '产品批号', '处置方式']
const dispositionOptions = DISPOSITION_OPTIONS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})

const stats = computed(() => [
  { label: meta.metrics[0], value: rows.value.filter((row) => row.status === '待评审').length },
  { label: meta.metrics[1], value: rows.value.filter((row) => row.status === '待复检').length },
  { label: meta.metrics[2], value: rows.value.filter((row) => row.status === '已办结').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type DialogKind = '' | 'create' | 'review' | 'reinspect' | 'close'
const dialog = ref<DialogKind>('')
const activeRow = ref<EntryRow | null>(null)
const dialogError = ref('')
const form = ref({
  处置单号: '',
  产品批号: '',
  不合格项目: '',
  不合格数量: '',
  处置方式: dispositionOptions[0],
  评审意见: '',
  复检结果: '合格',
  处置结论: '',
})

const dialogTitle = computed(() => {
  const code = activeRow.value ? String(activeRow.value['处置单号']) : ''
  switch (dialog.value) {
    case 'create':
      return '登记处置单（判定不合格）'
    case 'review':
      return `质量部评审 · ${code}`
    case 'reinspect':
      return `登记复检结果 · ${code}`
    case 'close':
      return `办结处置单 · ${code}`
    default:
      return ''
  }
})
const activeEffective = computed(() => (activeRow.value ? effectiveDispositionOf(activeRow.value) : ''))
const legalHints = computed(() => (activeRow.value ? legalConclusionsFor(activeRow.value) : []))

// 按状态机算每行当前可做的动作：只能往下走一格，走不了的按钮不出现。
function rowActions(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待评审') {
    return ['质量部评审']
  }
  if (status === '待复检') {
    return ['登记复检结果', '办结处置单']
  }
  const next = nextStatusOf(row)
  if (next === '待复检') {
    return ['提交复检']
  }
  if (next === '已办结') {
    return ['办结处置单']
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  form.value = { ...form.value, 处置单号: '', 产品批号: '', 不合格项目: '', 不合格数量: '' }
  dialogError.value = ''
  dialog.value = 'create'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  activeRow.value = row
  dialogError.value = ''
  if (action === '质量部评审') {
    form.value.处置方式 = dispositionOptions.includes(String(row['处置方式']))
      ? String(row['处置方式'])
      : dispositionOptions[0]
    form.value.评审意见 = ''
    dialog.value = 'review'
    return
  }
  if (action === '登记复检结果') {
    form.value.复检结果 = String(row['复检结果']) === '不合格' ? '不合格' : '合格'
    dialog.value = 'reinspect'
    return
  }
  if (action === '办结处置单') {
    form.value.处置结论 = ''
    dialog.value = 'close'
    return
  }
  // 提交复检不需要填单，直接走服务层。
  handle(submitReinspect(Number(row.id)))
}

function submitDialog() {
  dialogError.value = ''
  const row = activeRow.value
  let result: ActionResult
  if (dialog.value === 'create') {
    result = createDisposition({
      处置单号: form.value.处置单号,
      产品批号: form.value.产品批号,
      不合格项目: form.value.不合格项目,
      不合格数量: form.value.不合格数量,
    })
  } else if (dialog.value === 'review' && row) {
    result = reviewDisposition(Number(row.id), form.value.处置方式, form.value.评审意见)
  } else if (dialog.value === 'reinspect' && row) {
    result = recordReinspect(Number(row.id), form.value.复检结果)
  } else if (dialog.value === 'close' && row) {
    result = closeDisposition(Number(row.id), form.value.处置结论)
  } else {
    return
  }
  if (!result.ok) {
    // 打回重填：弹窗保持打开，改完再提交。
    dialogError.value = result.message
    return
  }
  successMessage.value = result.message
  closeDialog()
  reload()
}

function handle(result: ActionResult) {
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  reload()
}

function closeDialog() {
  dialog.value = ''
  activeRow.value = null
  dialogError.value = ''
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '处置单列表读取失败'
  }
}

onMounted(() => {
  // 对账：已办结的处置单都要在偏差处理里有一条待办，各入口看到的属同一套。
  reconcileDeviationTodos()
  reload()
})
</script>
