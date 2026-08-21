# Supabase Egress 与多用户扩展方案

> 创建日期：2026-08-21
> 最后更新：2026-08-21（已按生产实测字节数重排优先级，见《实测：一次 `/api/inbox` 的出站字节》与《推荐实施顺序》）
> 适用范围：PR Helper 的 Supabase 出站流量、看板轮询、状态投影、历史数据读取和多用户扩展。
> 当前状态：方案待实施；生产 Supabase Organization 在上个账单周期出现 `pr-helper` 项目 Egress 超额。

## 背景

2026-08-21 的 Supabase Usage 显示：

- Free Plan Egress 包含额度：5 GB。
- 当前周期出站流量：6.309 GB（126%）。
- 项目明细中 `pr-helper` 为 6.28 GB，`feng-projects` 为 0.02 GB。
- Database Size 为 0.047 GB，说明问题不是静态数据体积，而是重复查询与响应体传输。
- Supabase 宽限期到 2026-09-20；若仍超额，项目请求可能返回 402 并被限制。

## 当前根因判断

当前高频读取路径把“看板实时状态”和“历史详情数据”绑定在同一个 `/api/inbox` 接口中。

该接口在一次 `Promise.all` 中返回：

- actionable stages
- workflow stage states
- recent workflow stage events
- deployments
- deployment runs
- configuration warnings
- sync health
- workflow runs
- timeline
- recovery statuses
- unfinished automation actions

浏览器首页和详情页存在 30 秒轮询；手动刷新或流程操作还会触发带 `refresh=1` 的 inline reconciliation。页面长时间打开时，同一用户会反复拉取历史事件、timeline、部署运行记录和自动化动作。用户数增加时，Supabase Egress 和 Vercel 函数执行时间都会近似线性增长。

核心问题不是单条 SQL 没有索引，而是高频路径返回了过多低频数据，并且普通轮询可能触发 GitHub/Supabase 校准工作。

## 实测：一次 `/api/inbox` 的出站字节

2026-08-21 在生产库上按各查询的实际列和 LIMIT 逐条测量（`octet_length(row_to_json(...)::text)`，35 个流程 / 55 行 stage 投影 / 1049 行事件的规模）。`pg_stat_statements` 装了但 `prh_readonly` 无权读（schema `extensions` 拒绝），因此用字节量 × 频率推算而非直接取统计。

| 读取 | 字节 | 说明 |
| --- | --- | --- |
| `pr_helper_workflows.payload` | 70.8 kB **× 5** = 354 kB | 全量 35 行，被 `listWorkflowStageStates`、`listWorkflowConfigurationWarnings`、`listActionableStages`、`listRecoveryStatuses`、`listWorkflowTimeline` 各取一遍 |
| `workflow_stage_states` | 32 kB × 2 + 11 kB | 全量取两遍（`listWorkflowStageStates`、`listActionableStages`），`listSyncHealth` 再取一份窄列 |
| `workflow_stage_events` | 25.5 + 52.5 + 0.6 = 78.6 kB | LIMIT 100（recent）、200（timeline）、500（recovery，实际命中极少） |
| `workflow_runs` | 18.8 + 14.9 = 33.7 kB | 前者 LIMIT 50 且带 `stage_snapshot` jsonb |
| `workflow_stage_deployment_runs` | 31 kB | 每 (workflow, stage, source) 取最近 8，共 55 行 |
| `workflow_stage_deployments` | 16 kB | 全量 |
| **合计** | **≈ 588 kB / 次** | |

推算：浏览器每 30 秒一次 → **约 70 MB/小时**。5 GB 额度约等于 **71 小时**的页面打开时间；一个标签页挂 12 小时即约 **847 MB**。当前周期 6.28 GB 由此完全可解释，**不需要多用户，也不需要假设异常流量**。

两个结论修正了本文档原先的权重判断：

1. **最大的单项不是历史数据，而是同一次请求内重复读取的 `payload`**。354 kB 里有 283 kB（占整次请求 48%）是同一批 35 行被反复取回，删掉它对外部行为零影响。
2. **轮询根本不会停**。[`src/main.ts:429`](../src/main.ts) 的 `setInterval` 30 秒在页面隐藏时继续跑，`visibilitychange` 只是「回到前台额外刷一次」；详情页 [`src/main.ts:2140`](../src/main.ts) 同样。挂机的后台标签页因此是最大的实际来源，而这一项在原推荐顺序里排第 3。

因此原文《推荐实施顺序》里把 `/api/board` 拆分排第一是错的：那一刀改动最大、收益（历史数据 143 kB，24%）最小。修正后的顺序见文末。

## 设计目标

- 首页 Lane 看板只读取渲染当前卡片所需的最小数据。
- 历史时间线、事件、部署运行、审计记录只在用户打开详情/抽屉时按需加载。
- 普通轮询只读服务端投影，不触发 GitHub API 校准。
- 没有状态变化时，轮询响应尽量接近空响应。
- Webhook、cron 和自动化队列负责后台推进；浏览器只展示状态。
- 多用户打开同一仓库时，不能让每个浏览器重复触发同一轮 GitHub 校准。
- 历史数据有保留期限和分页，避免随运行时间无限进入高频响应。

## 第一阶段：立刻止血

### 1. 新增轻量看板接口

新增 `/api/board`，只返回首页 Lane 渲染必需字段：

- workflow id / name / repository / position / archived / team role
- stages 的 source / target / independent / waitFor / stageId
- 每个 stage 的当前展示状态、PR 编号、门禁摘要、aheadBy
- 当前待办数量
- 未完成自动化动作数量
- 最近同步时间与是否 stale
- 全局错误/配置警告数量

不返回：

- recent events
- timeline
- workflow runs
- deployment runs
- operation audit logs
- 大段 failure details
- 已完成自动化动作历史

### 2. 详情数据按需加载

以下数据改为进入流程详情页、步骤抽屉或对应 Tab 时请求：

- timeline
- recent stage events
- deployment runs
- workflow runs
- operation audit logs
- automation action history

接口可以继续复用 `/api/inbox?resource=...` 或拆成更明确的资源接口，但必须避免首页轮询携带这些数据。

### 3. 调整轮询策略

建议默认策略：

- 页面可见：60 秒轮询轻量 board projection。
- 页面隐藏：暂停轮询。
- 页面重新可见：立即刷新一次。
- 手动点击“刷新 GitHub 状态”：才触发 `refresh=1` 的 GitHub reconciliation。
- 轮询失败：指数退避，例如 15s → 30s → 60s，成功后恢复 60s。

流程详情页也应使用同一策略，只对当前流程请求详情，不刷新所有历史数据。

### 4. 限制首页自动化动作数据

首页只需要未完成动作的摘要：

- `queued/running/paused/failed` 数量
- 当前 workflow/stage/source/target
- 最近失败原因的短文案

完整动作历史只在抽屉或“自动化运行记录”中分页读取。

### 5. 避免普通轮询触发校准

`/api/inbox` 当前在 `refresh=1` 时执行 `reconcileRealtime`。必须保证：

- 自动轮询不带 `refresh=1`。
- 只有手动刷新、创建/合并 PR 后的短延迟刷新、Webhook/cron 可以触发校准。
- 同一 repository / installation 的校准由服务端锁和队列串行化。

## 第二阶段：增量更新

### 1. Board version

为用户维度或用户可见 workflow 维度维护一个递增版本，例如：

```text
workflow_board_snapshots
- user_id
- workflow_id
- board_version
- summary_json
- updated_at
```

浏览器轮询时携带：

```text
GET /api/board?version=<last_version>
```

无变化时返回：

```json
{ "changed": false, "version": 123 }
```

有变化时只返回变化的 workflow 或完整轻量快照（第一版可返回完整快照，后续再做 per-workflow patch）。

### 2. ETag / 304

在 board projection 稳定后增加 ETag 或等价 hash：

- 浏览器发送 `If-None-Match`。
- 投影未变化返回 `304 Not Modified`。
- 避免重复传输 JSON body。

### 3. 单流程增量

当用户停留在流程详情页时，只轮询该流程：

```text
GET /api/board?workflowId=<id>
```

抽屉中的历史数据只在打开时拉取，不随轮询刷新；需要刷新时由用户手动点击或在动作执行期间局部刷新。

## 第三阶段：服务端投影表

新增面向读取的看板投影表，而不是让每次请求跨表拼装。

建议字段：

- `user_id`
- `workflow_id`
- `stage_id`
- `stage_index`
- `source`
- `target`
- `state_kind`
- `pr_number`
- `pr_state`
- `checks_state`
- `approvals`
- `required_approvals`
- `ahead_by`
- `actions_summary`
- `last_changed_at`
- `last_synced_at`
- `board_version`

写入时机：

- GitHub Webhook 到达时
- cron reconciliation 完成时
- 自动化动作状态变化时
- 部署/健康检查状态变化时
- 流程配置更新时

读取接口只查投影表，并使用 `(user_id, updated_at)`、`(workflow_id, stage_index)` 等索引。

历史表仍然作为审计和详情来源，不进入首页高频路径。

## 第四阶段：自动化与浏览器解耦

自动创建 PR、自动合并、状态校准必须由服务端推进：

- Push / PR / Check / Workflow / Status Webhook 触发对应仓库校准。
- pg_cron / GitHub Actions cron 负责兜底。
- 浏览器只展示未完成动作和失败原因。
- 自动化动作执行完成后更新 board projection。
- 多个用户同时打开同一仓库，不重复触发 GitHub API 调用。

这一步是多用户扩展的关键。否则用户数越多，后台校准和 GitHub API 压力会被浏览器放大。

## 第五阶段：历史数据治理

重点表：

- `workflow_stage_events`
- `workflow_automation_actions`
- `workflow_runs`
- `workflow_stage_deployment_runs`
- `github_webhook_deliveries`
- `operation_audit_logs`

策略：

- 首页只查未完成动作和最近状态，不查历史大列表。
- 时间线默认最近 30 条，支持“加载更多”。
- 自动化动作默认分页 20–50 条。
- Webhook delivery 默认只保留 30 天。
- 明细事件默认保留 90 天，之后聚合或删除。
- 审计日志按合规需求保留更长时间，但读取必须分页并限定 workflow/time range。

实施前需要确认现有 `022_data_retention.sql` 的保留策略是否覆盖这些表，并在需要时新增迁移。

## 第六阶段：多租户保护

当真实用户增加后，需要补齐：

- 按用户 / installation / repository 的速率限制。
- 手动刷新冷却时间，避免连点触发多次 GitHub 校准。
- 同一仓库全局 reconciliation lock。
- GitHub API token 使用预算和熔断。
- 活跃项目优先校准；长期不活跃项目降频。
- 单用户返回的 workflow 数量分页或虚拟滚动。
- 团队共享 workflow 不重复计算 N 倍校准。

## 推荐实施顺序

> 2026-08-21 按实测字节数重排。原顺序（`/api/board` 优先）已作废，理由见《实测：一次 `/api/inbox` 的出站字节》。

**第一刀 B：轮询隐藏即停 + 间隔改 60 秒。** 改动最小（`clearInterval` / 重新可见时重启 + 一个常量），真实收益最大：挂机标签页从约 847 MB/晚 降到 0，前台从 70 MB/小时 降到约 35 MB/小时。首页 [`src/main.ts:428`](../src/main.ts) 的 `startOverviewSnapshotPolling` 与详情页 [`src/main.ts:2140`](../src/main.ts) 的 `pollTimer` 都要改。注意现有的 `visibilitychange` / `focus` 监听要从「额外刷一次」改成「重启定时器并立刷一次」，否则回到前台会不再轮询。

**第二刀 A：请求内去重。** 在 [`api/[action].ts`](../api/[action].ts) 的 `Promise.all` 之前先取一次 `pr_helper_workflows.payload` 与 `workflow_stage_states`，作为参数传进那 5 个 / 2 个 list 函数，而不是各自再查。**省 283 kB / 次，单次 -48%**，接口形状、UI 和轮询语义全不变，属纯内部改动。代价是这些 list 函数要接受可选的预取参数，签名变宽；其他调用方（详情页、抽屉）不传时保持原行为。

B + A 合计：70 MB/小时 → 约 **9 MB/小时**，挂机场景归零，约为当前的 1/8。这足以把一个完整账单周期压回 5 GB 以内。

**其余按需再做，不预先承诺：**

3. 首页自动化动作改为摘要，不读取历史（当前 `unfinishedOnly` 已经在做，`AUTOMATION_ACTION_VIEW_LIMIT` 值得复核）。
4. 把历史数据从轮询里摘出去（events / timeline / runs / deployment_runs 共 143 kB，24%）——即原方案的 `/api/board` 与按需加载。**收益最小、改动最大，放在 B + A 观察一周之后再决定是否需要。**
5. 增加 board version / ETag，空变化返回极小响应。
6. 建立服务端 board projection 表。
7. 补齐历史数据分页与保留策略。
8. 加入多用户下的 reconciliation lock、限流和 GitHub API 预算。

## 验收标准

B + A 完成后（可直接量化，不需要等账单周期）：

- 页面隐藏时不产生任何 `/api/inbox` 请求（DevTools Network 观察，或看 Vercel 函数调用数）。
- 前台轮询间隔为 60 秒，回到前台立即刷新一次且定时器恢复。
- 单次 `/api/inbox` 响应体与数据库出站字节相比改前约降一半；`pr_helper_workflows` 在一次请求内只被查一次。
- 首页看板、失败中心、时间线、抽屉的显示内容与改前完全一致（这两刀都不减少返回的数据，只减少重复传输和请求次数）。
- Supabase Usage 的 Egress 日增量明显下降；连续观察一周后再判断是否需要第 4 步。

第四步（`/api/board`）若日后实施，验收标准为：

- 首页轮询响应体不再包含 timeline、deployment runs、workflow runs、operation audit 和已完成自动化历史。
- 普通自动轮询不触发 GitHub reconciliation。
- 手动刷新仍能更新 GitHub 状态。
- 详情页和抽屉中的历史数据功能不丢失。
- 本地测试和生产观察均显示 `/api/board` 平均响应体显著小于当前 `/api/inbox`。

第二阶段完成后：

- 无状态变化时，轮询响应接近空 body 或 304。
- 多个打开的标签页不会产生重复校准。
- Supabase Egress 在连续运行一周后明显下降。

## 临时运营建议

在第一刀 B 上线前：

- 不要把首页或流程详情页长时间挂在后台标签里——按实测这就是最大的单一来源（约 847 MB / 12 小时）。B 上线后这条自动失效。
- 宽限期到 2026-09-20。在 B + A 上线并观察一周之前，临时启用 Supabase 按量付费或升一档是保底手段而非替代方案，用来避免 402 打断生产。
- 优化上线后观察一个完整账单周期，再决定是否需要继续降频或升级套餐。
