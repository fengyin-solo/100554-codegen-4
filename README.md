# 制药企业洁净区与批生产记录管理平台

面向洁净区环境监测、批生产记录编录、物料放行、偏差与变更控制、灭菌与清洁验证、成品检验与年度质量回顾的一体化药品生产质量管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 批生产记录 | `batchrecord` | 批生产记录 | 批号、产品名称、生产工序 |
| 洁净区环境监测 | `cleanroom` | 环境监测记录 | 监测点位、洁净级别、悬浮粒子数 |
| 物料放行 | `materialrelease` | 物料放行单 | 物料批号、物料名称、供应商 |
| 偏差处理 | `deviation` | 偏差记录 | 偏差编号、偏差类型、发生工序 |
| 不合格品与返工返修台账 | `nonconforming` | 不合格品处置单（NCR） | 处置单号、批号、处置方式、当前状态、持有人 |
| 变更控制 | `changecontrol` | 变更申请 | 变更编号、变更类别、涉及工序 |
| 清洁验证 | `cleanvalidate` | 清洁验证记录 | 验证编号、设备名称、清洁规程 |
| 灭菌验证 | `sterilize` | 灭菌验证记录 | 验证编号、灭菌设备、灭菌程序 |
| 培养基模拟灌装 | `mediafill` | 模拟灌装记录 | 灌装编号、灌装规格、灌装批量 |
| 工艺用水监测 | `watermonitor` | 水质监测记录 | 取样点、水系统类别、电导率 |
| 更衣确认 | `gowning` | 更衣确认记录 | 确认编号、洁净级别、更衣步骤 |
| 成品检验 | `finishedqc` | 成品检验报告 | 检验编号、产品批号、检验项目 |
| 留样管理 | `retainsample` | 留样记录 | 留样编号、对应批号、留样数量 |
| 稳定性考察 | `stability` | 稳定性考察记录 | 考察编号、考察批号、考察条件 |
| 产品召回 | `recall` | 召回记录 | 召回编号、涉及批号、召回级别 |
| 供应商审计 | `supplieraudit` | 供应商审计记录 | 审计编号、供应商名称、物料类别 |
| 人员培训 | `training` | 培训记录 | 培训编号、培训主题、受训岗位 |
| 年度质量回顾 | `annualreview` | 年度回顾报告 | 回顾编号、回顾年度、涉及产品 |
| 质量投诉 | `complaint` | 投诉记录 | 投诉编号、投诉来源、涉及产品 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `pharma-cleanroom:entries` 这一项，或调用 `resetModule(模块)`。

## 不合格品与返工返修台账（独立状态机）

处置单（NCR）业务规则比通用模块硬，单独成卷（`frontend/src/data/ncr-types.ts` 状态机、
`ncr-seed.ts` 示例、`ncr-store.ts` 存储键 `pharma-cleanroom:ncr-orders`，服务在
`src/api/ncr-service.ts`）：

- **全链路**：判定不合格开单 → 质量部评审分流 →（返工/返修派工执行 → 待复检）/（让步处理）→ 办结。
- **分流车道**：返工、返修、让步接收各走各的，走错车道拒收；返工/返修执行完成**必须进复检**，
  复检有结论才能办结，让步车道无复检环节。
- **质量部门禁**：评审意见只能由「质量部」出具，其他部门提交拒收。
- **状态只能往下流转**：只允许 `FORWARD_TRANSITIONS` 登记的相邻流转，回退/平级重复/跳级一律拒收。
- **开单幂等**：同一来源单号 + 同一批号只能开出一张处置单，重复提交只算一次（返回 `duplicated`）。
- **处置结论同源**：初判建议与评审意见都留痕在 `proposals`，撞车按 **返工 &gt; 返修 &gt; 让步接收**
  的优先级取一版；台账、时间线、偏差待办各入口读到的是同一份结论。
- **非法值打回**：处置结论只认「返工/返修/让步接收」，复检结论只认「合格/不合格」，其余打回重填。
- **偏差待办回写**：评审一定结论就生成 `DEVI-NCR-xxxx` 待办写入偏差处理模块；未办结在偏差台账是
  「待处理」，办结后同步「已关闭」，复检不合格同步异常标记。该待办只能在 NCR 流程里推进，
  偏差页手工动作会被拦下，保证两处同源。
- 回到初始数据：台账页「重置示例数据」，或清掉 `pharma-cleanroom:ncr-orders` 与
  `pharma-cleanroom:entries`（偏差待办会在下次进入时重新同步）。
