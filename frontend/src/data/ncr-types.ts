/**
 * 不合格品与返工返修台账：领域类型 + 状态机常量。
 * 一张处置单从「判定不合格」一路走到「办结」，状态机是全模块唯一的流转依据。
 */

/** 合法处置方式白名单：填成别的值一律打回重填。 */
export const DISPOSITIONS = ['返工', '返修', '让步接收'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

/**
 * 处置单状态：按处置方式分流，各走各的车道——
 * 返工：待评审 → 已评审 → 返工中 → 待复检 → 办结
 * 返修：待评审 → 已评审 → 返修中 → 待复检 → 办结
 * 让步：待评审 → 已评审 → 让步待办 → 办结
 * 返工/返修批次在执行完成后必须进「待复检」，复检有结论才能办结。
 */
export const NCR_STATUSES = [
  '待评审',
  '已评审',
  '返工中',
  '返修中',
  '让步待办',
  '待复检',
  '办结',
] as const
export type NcrStatus = (typeof NCR_STATUSES)[number]

/** 复检结论合法值。 */
export const RECHECK_RESULTS = ['合格', '不合格'] as const
export type RecheckResult = (typeof RECHECK_RESULTS)[number]

/** 评审部门：评审意见只能由质量部出具。 */
export const QA_DEPARTMENT = '质量部'

/**
 * 处置方式撞车时的优先级：返工 > 返修 > 让步接收。
 * 让步接收与返工/返修撞上时，以优先级高的那一版为准。
 */
export const DISPOSITION_PRIORITY: Record<Disposition, number> = {
  返工: 3,
  返修: 2,
  让步接收: 1,
}

/** 状态位次：只准往高位走，平级/回退/跳级一律拒收。 */
export const STATUS_RANK: Record<NcrStatus, number> = {
  待评审: 0,
  已评审: 1,
  返工中: 2,
  返修中: 2,
  让步待办: 2,
  待复检: 3,
  办结: 4,
}

/** 允许的相邻流转：显式登记，跳一步都不行。 */
export const FORWARD_TRANSITIONS: Record<NcrStatus, NcrStatus[]> = {
  待评审: ['已评审'],
  已评审: ['返工中', '返修中', '让步待办'],
  返工中: ['待复检'],
  返修中: ['待复检'],
  让步待办: ['办结'],
  待复检: ['办结'],
  办结: [],
}

export type ProposalSource = '初判建议' | '评审意见'

/** 处置主张：初判建议与质量部评审意见都留痕，撞车时按优先级取。 */
export type DispositionProposal = {
  disposition: Disposition
  source: ProposalSource
  actor: string
  department: string
  at: string
  opinion: string
}

/** 流转时间线：单子停在谁手里、办了什么，全在这里，不用再问人。 */
export type TimelineEvent = {
  at: string
  action: string
  actor: string
  department: string
  fromStatus: NcrStatus | ''
  toStatus: NcrStatus
  note: string
}

export type NcrOrder = {
  id: number
  code: string
  status: NcrStatus
  abnormal: boolean

  // —— 判定不合格（开单）——
  sourceType: string
  sourceNo: string
  batchNo: string
  productName: string
  quantity: string
  nonConformity: string
  foundBy: string
  foundAt: string

  // —— 分流与质量部评审 ——
  disposition: Disposition | ''
  proposals: DispositionProposal[]
  reviewOpinion: string
  reviewer: string
  reviewedAt: string

  // —— 返工/返修执行 ——
  executor: string
  executionRequirement: string
  reworkBatchNo: string
  executedAt: string

  // —— 让步接收 ——
  concessionNote: string
  concessionApprover: string
  concessionAt: string

  // —— 返工批次复检 ——
  recheckResult: RecheckResult | ''
  recheckInspector: string
  recheckNote: string
  recheckedAt: string

  // —— 办结 ——
  finalConclusion: string

  /** 进入当前状态的日期：算「停在谁手里、停了几天」就靠它。 */
  heldSince: string
  /** 反映到偏差处理待办的偏差编号；空表示尚未产生待办。 */
  deviationCode: string

  timeline: TimelineEvent[]
}

export type NcrActionResult = {
  ok: boolean
  message: string
  /** 重复提交同一单时返回 true：只算一次，不产生第二条记录。 */
  duplicated?: boolean
  order?: NcrOrder
}
