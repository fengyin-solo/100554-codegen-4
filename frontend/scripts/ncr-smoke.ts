import {
  completeExecution,
  createNcrOrder,
  dispatchExecution,
  enterConcession,
  finishConcession,
  listNcrOrders,
  submitRecheck,
  submitReview,
  syncDeviationTodos,
} from '../src/api/ncr-service'
import { listRows, resetRows } from '../src/data/local-store'
import { resetNcrOrders } from '../src/data/ncr-store'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

resetNcrOrders()
resetRows('deviation')

console.log('— 1. 非法处置结论打回重填 —')
let r = createNcrOrder({
  sourceType: '成品检验', sourceNo: 'QC-T1', batchNo: 'B-T1', productName: '测试品A',
  quantity: '100', nonConformity: '装量差异', foundBy: '甲', foundAt: '2026-10-03',
  initialDisposition: '特殊放行',
})
check('开单时非法初判结论被打回', !r.ok && r.message.includes('非法值'), r.message)

console.log('— 2. 合法开单 + 重复提交只算一次 —')
r = createNcrOrder({
  sourceType: '成品检验', sourceNo: 'QC-T1', batchNo: 'B-T1', productName: '测试品A',
  quantity: '100', nonConformity: '装量差异', foundBy: '甲', foundAt: '2026-10-03',
  initialDisposition: '返工',
})
check('首次开单成功', r.ok, r.message)
const id1 = r.order!.id
r = createNcrOrder({
  sourceType: '成品检验', sourceNo: 'QC-T1', batchNo: 'B-T1', productName: '测试品A',
  quantity: '100', nonConformity: '装量差异', foundBy: '甲', foundAt: '2026-10-03',
  initialDisposition: '返工',
})
check('同源单同批号重复提交被拒且标记 duplicated', !r.ok && r.duplicated === true, r.message)

console.log('— 3. 评审部门禁：非质量部拒收 —')
r = submitReview(id1, { department: '生产一车间', reviewer: '乙', disposition: '返工', opinion: '车间自审' })
check('车间无权出具评审意见', !r.ok && r.message.includes('质量部'), r.message)

console.log('— 4. 评审非法值打回 —')
r = submitReview(id1, { department: '质量部', reviewer: '孙质量', disposition: '直接报废', opinion: '意见' })
check('评审结论非法值打回', !r.ok && r.message.includes('非法值'), r.message)

console.log('— 5. 状态机跳级拒收（待评审不能直接送复检/办结）—')
r = submitRecheck(id1, { result: '合格', inspector: '丙', note: '', recheckedAt: '2026-10-03' })
check('待评审阶段提交复检被拒', !r.ok, r.message)
r = completeExecution(id1, { executor: '班', requirement: '', reworkBatchNo: 'RW1', executedAt: '2026-10-03' })
check('未派工先登记执行完成被拒', !r.ok, r.message)

console.log('— 6. 优先级冲突：初判返工 vs 评审让步 → 取返工 —')
r = submitReview(id1, { department: '质量部', reviewer: '孙质量', disposition: '让步接收', opinion: '评审想让步' })
check('评审提交成功', r.ok, r.message)
let order = listNcrOrders().find((o) => o.id === id1)!
check('返工优先级高于让步接收，最终分流返工', order.disposition === '返工', `实际=${order.disposition}`)

console.log('— 7. 走错车道拒收（返工单不能进让步车道）—')
r = enterConcession(id1, '孙质量', '试走让步')
check('返工单走让步车道被拒', !r.ok && r.message.includes('让步接收车道'), r.message)

console.log('— 8. 返工全链路：派工→缺返工批次号拒收→执行→待复检→非法复检值打回→复检合格办结 —')
r = dispatchExecution(id1, '孙质量', '质量部')
check('派工成功进入返工中', r.ok, r.message)
r = completeExecution(id1, { executor: '', requirement: '', reworkBatchNo: '', executedAt: '' })
check('缺执行人/日期被拒', !r.ok, r.message)
r = completeExecution(id1, { executor: '钱班长', requirement: '重新干燥', reworkBatchNo: '', executedAt: '2026-10-03' })
check('返工缺返工批次号被拒', !r.ok && r.message.includes('返工批次号'), r.message)
r = completeExecution(id1, { executor: '钱班长', requirement: '重新干燥', reworkBatchNo: 'B-T1-RW', executedAt: '2026-10-03' })
check('执行完成进入待复检', r.ok, r.message)
r = submitRecheck(id1, { result: '让步放行', inspector: '丙', note: '', recheckedAt: '2026-10-03' })
check('复检非法值打回', !r.ok && r.message.includes('非法值'), r.message)
r = submitRecheck(id1, { result: '合格', inspector: '丙', note: '全项合格', recheckedAt: '2026-10-03' })
check('复检合格办结', r.ok, r.message)
order = listNcrOrders().find((o) => o.id === id1)!
check('最终状态办结且非异常', order.status === '办结' && order.abnormal === false)

console.log('— 9. 办结后重复提交拒收 —')
r = submitRecheck(id1, { result: '合格', inspector: '丙', note: '', recheckedAt: '2026-10-03' })
check('办结单再操作被拒', !r.ok, r.message)

console.log('— 10. 让步接收车道全程 —')
r = createNcrOrder({
  sourceType: '成品检验', sourceNo: 'QC-T2', batchNo: 'B-T2', productName: '测试品B',
  quantity: '200', nonConformity: '标签色差', foundBy: '丁', foundAt: '2026-10-03',
  initialDisposition: '',
})
const id2 = r.order!.id
r = submitReview(id2, { department: '质量部', reviewer: '周质量', disposition: '让步接收', opinion: '不影响安全' })
check('让步评审成功', r.ok && r.order!.disposition === '让步接收', r.message)
r = dispatchExecution(id2, '周质量', '质量部')
check('让步单不能走返工/返修派工', !r.ok, r.message)
r = enterConcession(id2, '周质量', '随货附说明')
check('进入让步待办', r.ok, r.message)
r = finishConcession(id2, '周质量')
check('让步办结', r.ok && r.order!.status === '办结', r.message)

console.log('— 11. 复检不合格 → 办结但标记异常 —')
r = createNcrOrder({
  sourceType: '过程检验', sourceNo: 'IPQ-T3', batchNo: 'B-T3', productName: '测试品C',
  quantity: '30kg', nonConformity: '内毒素超标', foundBy: '戊', foundAt: '2026-10-03',
  initialDisposition: '返工',
})
const id3 = r.order!.id
submitReview(id3, { department: '质量部', reviewer: '孙质量', disposition: '返工', opinion: '重新灭菌' })
dispatchExecution(id3, '孙质量', '质量部')
completeExecution(id3, { executor: '韩班长', requirement: '重新灭菌', reworkBatchNo: 'B-T3-RW', executedAt: '2026-10-03' })
r = submitRecheck(id3, { result: '不合格', inspector: '甲', note: '仍超标转报废', recheckedAt: '2026-10-03' })
check('复检不合格办结但标异常', r.ok && r.order!.abnormal === true, r.message)

console.log('— 12. 结论反映到偏差处理待办，两处同源 —')
syncDeviationTodos()
const devRows = listRows('deviation')
const todo1 = devRows.find((d) => d['偏差编号'] === 'DEVI-NCR-0012')
check('新处置单生成对应偏差待办', !!todo1, `待办数=${devRows.length}`)
check('办结合格的待办在偏差台账为已关闭/非待办', todo1 && todo1.status === '已关闭' && todo1.pending === false)
const todoAbn = devRows.find((d) => d['偏差编号'] === 'DEVI-NCR-0014')
check('复检不合格的待办同步异常标记', todoAbn?.abnormal === true)
const pendingTodos = devRows.filter((d) => String(d['偏差编号']).startsWith('DEVI-NCR-') && d.pending)
check('示例数据中未办结的处置单在偏差台账仍是待处理', pendingTodos.length > 0)

console.log(`— 13. 返修车道（无返工批次号强制，执行后仍须复检）—`)
r = createNcrOrder({
  sourceType: '成品检验', sourceNo: 'QC-T4', batchNo: 'B-T4', productName: '测试品D',
  quantity: '6000', nonConformity: '喷码模糊', foundBy: '己', foundAt: '2026-10-03',
  initialDisposition: '',
})
const id4 = r.order!.id
submitReview(id4, { department: '质量部', reviewer: '孙质量', disposition: '返修', opinion: '重新喷码' })
dispatchExecution(id4, '孙质量', '质量部')
r = completeExecution(id4, { executor: '蒋班长', requirement: '重新喷码', reworkBatchNo: '', executedAt: '2026-10-03' })
check('返修执行完成（批次号非强制）进待复检', r.ok, r.message)
r = finishConcession(id4, '孙质量')
check('待复检单不能走让步办结（必须复检）', !r.ok, r.message)

console.log(`— 14. 初始评审冲突反向：初判让步 vs 评审返工 → 取返工 —`)
r = createNcrOrder({
  sourceType: '成品检验', sourceNo: 'QC-T5', batchNo: 'B-T5', productName: '测试品E',
  quantity: '800', nonConformity: '含量偏低', foundBy: '庚', foundAt: '2026-10-03',
  initialDisposition: '让步接收',
})
const id5 = r.order!.id
submitReview(id5, { department: '质量部', reviewer: '孙质量', disposition: '返工', opinion: '含量不可让步' })
order = listNcrOrders().find((o) => o.id === id5)!
check('评审返工覆盖初判让步', order.disposition === '返工', `实际=${order.disposition}`)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
