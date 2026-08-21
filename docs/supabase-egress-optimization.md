# Supabase Egress 与多用户扩展方案

> 创建日期：2026-08-21
> 最后更新：2026-08-21（新增《实测：扫掠频率与 webhook 事件分布》《需求澄清：事件驱动，不是无人值守》《第二轮：按真实需求降配（A1 / A2 / A3）》《第三轮：把过滤与批次下推到 SQL》）
> 适用范围：PR Helper 的 Supabase 出站流量、看板轮询、状态投影、历史数据读取和多用户扩展。
> 当前状态：三刀已落地（`1e5c6758` / `2b81be2c` / `98b5d245`）；第二轮 A1 / A2 / A3 已落地（`e65daa6c` / `b51bcaed` / `538a33eb`），投影约 1.71 GB/月，待部署后核对；第三轮（SQL 下推）已落地（`7b3a7e03` / `a1054240` / `dfc9491c`），迁移 034 待应用。

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

推算：浏览器每 30 秒一次 → **约 70 MB/小时**。5 GB 额度约等于 **71 小时**的页面打开时间。当前周期 6.28 GB 由此完全可解释（每天前台使用 4 小时、一个月即到量），**不需要多用户，也不需要假设异常流量**。

两个结论修正了本文档原先的权重判断：

1. **最大的单项不是历史数据，而是同一次请求内重复读取的 `payload`**。354 kB 里有 283 kB（占整次请求 48%）是同一批 35 行被反复取回，删掉它对外部行为零影响。
2. **只有详情页的轮询在页面隐藏时不停**。首页 `refreshOverviewSnapshot`（[`src/main.ts:400`](../src/main.ts)）开头本来就有 `document.visibilityState !== 'visible'` 即返回，所以首页挂后台一直是 0 请求；详情页 [`src/main.ts:2140`](../src/main.ts) 的 `pollTimer` 则没有这道判断，挂后台会每 30 秒既直连 GitHub 又拉一次 588 kB。**（本文档 2026-08-21 首版曾写成「首页轮询也不会停、挂机一晚约 847 MB」，那是错的，已按源码更正。）**

因此原文《推荐实施顺序》里把 `/api/board` 拆分排第一是错的：那一刀改动最大、收益（历史数据 143 kB，24%）最小。修正后的顺序见文末。

## 实测：三刀落地后的对比

同日在同一份生产数据上（35 个流程 / 55 行 stage 投影 / 55 条 run）按新旧列组合各量一遍，故两列可直接相减。涉及提交 `1e5c6758`（轮询）、`2b81be2c`（请求内去重）、`98b5d245`（去掉 `stage_snapshot`）。

| 读取 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| `pr_helper_workflows.payload` | 71.3 kB × 5 = **356.3 kB** | 73.0 kB × 1 = **73.0 kB** | **−283.3 kB** |
| `workflow_stage_states`（全列） | 32.4 kB × 2 = 64.8 kB | 32.4 kB × 1 = 32.4 kB | −32.4 kB |
| `workflow_runs`（LIMIT 50） | 18.8 kB | 14.1 kB | −4.7 kB |
| `workflow_stage_states`（窄列，syncHealth） | 12.0 kB | 12.0 kB | — |
| `workflow_stage_events` 100 / 200 / rerun 500 | 25.5 + 52.5 + 0.6 kB | 同 | — |
| `workflow_runs`（timeline，LIMIT 100） | 14.9 kB | 同 | — |
| `workflow_stage_deployment_runs`（每组最近 8） | 31.0 kB | 同 | — |
| `workflow_stage_deployments` | 16.4 kB | 同 | — |
| `workflow_automation_actions`（未完成） | 1.6 kB | 同 | — |
| **单次合计** | **594.3 kB** | **274.0 kB** | **−320.3 kB（−53.9%）** |

按频率折算：

| 场景 | 优化前 | 优化后 |
| --- | --- | --- |
| 前台每小时 | 120 次 × 594.3 kB = **71.3 MB** | 60 次 × 274.0 kB = **16.4 MB**（−77%） |
| 详情页挂后台每小时 | 71.3 MB | **0** |
| 首页挂后台每小时 | 0（本来就有可见性判断） | 0 |
| 5 GB 额度可支撑的前台时长 | 约 **70 小时** | 约 **312 小时** |

两点口径说明，读数字前要知道：

1. 共享那次 payload 读取时加上了 `workflows.id`（`listWorkflowTimeline` 需要按 id 建 map），所以单次从 71.3 涨到 73.0 kB，**多 1.8 kB**——换掉的是重复的 4 遍共 283 kB。
2. 这些是行数据序列化成 JSON 的字节数，用来近似 Postgres → 函数的出站量，不等于 HTTP 响应体（后者还会 gzip）。Supabase 计的 Egress 是前者，所以这个口径可比。

## 实测：扫掠频率与 webhook 事件分布

前面三刀只动了浏览器发起的读取。2026-08-21 进一步查了服务端常驻负载，发现它的量级和浏览器同级甚至更大。

`reconcileWorkflowStages` 每次都在 [`api/_lib/workflows-store.ts:2121`](../api/_lib/workflows-store.ts) 无条件读整张 `pr_helper_workflows`（无 `WHERE`、无 `LIMIT`），过滤全在 JS 里做，最后只取 `RECONCILE_WORKFLOW_BATCH_SIZE = 8` 条。[`projectPullRequestWebhook`](../api/_lib/workflows-store.ts) 在 `:1507` 同样。所以**每一次扫掠都要付一份全表 payload 的出站量**，当前 35 个流程 = 71.3 kB。

近 7 天 `reconciliation_runs` 的扫掠频率：

| 触发源 | 次/天 | 月出站（× 71.3 kB × 30） |
| --- | --- | --- |
| `webhook` | 916.0 | 1959 MB |
| `cron`（pg_cron `*/5`，289 ≈ 288 吻合） | 289.1 | 618 MB |
| `manual` | 11.9 | 25 MB |
| `inbox_refresh` | 4.4 | 9 MB |

同期 `github_webhook_deliveries` 按 event + action 细分：

| 事件 | 次/天 | 能否改变合并判定 |
| --- | --- | --- |
| `check_run.created` | 181.1 | **不能**——检查刚开始 |
| `check_run.completed` | 168.0 | 能 |
| `check_suite.completed` | 138.1 | 能（聚合口） |
| `workflow_run.requested` | 120.6 | 不能，但这是部署 run 行首次出现的时刻 |
| `workflow_run.in_progress` | 117.3 | **不能** |
| `workflow_run.completed` | 114.4 | 能 |
| `pull_request.*` | 56.3 | 能 |
| `push` | 46.4 | 能 |
| `status` | 40.9 | 能 |

结论：`check_run.created` + `workflow_run.in_progress` = **298.4 次/天**在读整张表，而它们在语义上不可能让任何 PR 从不可合并变成可合并。这是纯浪费。

已核对过它们对展示的影响：[`deploymentRunState`](../api/_lib/workflows-store.ts) 在 `:683` 的判定是 `status !== 'completed' → 'pending'`，非终态一律记为 pending。而 pending 在 `workflow_run.requested` 那次扫掠就已写入，`in_progress` 再来一次是同值重写。因此跳过 `in_progress` 零损失；`requested` 必须保留，否则部署 run 行要等到跑完才出现。

`drainWorkflowAutomationActions`（pg_cron `*/2`，720 次/天）不在此列：它的 SELECT 有 `LIMIT AUTOMATION_DRAIN_BATCH_SIZE`，且只取 `payload->>'repository'` 等少量字段，出站量可忽略。

## 需求澄清：事件驱动，不是无人值守

2026-08-21 确认了实际需求：**写代码 → 提交 commit → 识别到新 commit 且满足阈值 → 自动创建 PR → 门禁绿了自动合并**。触发源是本人的 push，完成窗口是分钟级（等 CI），不是隔夜。

这条链路现在走的**不是定时器**：[`api/github/webhook.ts:39`](../api/github/webhook.ts) 对任何被接受的投递当场同步跑 `reconcileRealtime`，并用 [`webhookBranchesForEvent`](../api/_lib/workflows-store.ts)（`:1147`）把范围收窄到该投递涉及的分支。代码注释写明这么做是为了「效果立刻可见，而不是等下一次定时扫掠」。实测 webhook 916 次/天 vs cron 289 次/天，也印证 webhook 是主路径。

所以 pg_cron `*/5` 的定位是**webhook 丢投递时的补漏网**，不是功能主干。这一认识是下面 A1 的依据。

注意：[030 迁移](../db/migrations/030_reconciliation_pg_cron_clock.sql) 里「`*/10` 实测 46 分钟才投递一次」的教训只适用于 GitHub Actions 的 `schedule:`；`on: push` / `on: check_suite` 是 webhook 驱动，秒级投递，不受该问题影响。

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

## 第二轮：按真实需求降配（A1 / A2 / A3）

> 2026-08-21 新增。依据是《实测：扫掠频率与 webhook 事件分布》和《需求澄清：事件驱动，不是无人值守》。
> 前提：三刀之后单账单周期已在 5 GB 以内，这一轮是**买余量，不是救火**。
> 落地状态：三项均已实现，见各节标题的提交号。A1 的迁移文件已提交但**尚未应用**，需要使用者自己执行。

### 现状基线（投影，非实测账单）

| 项 | 月出站 |
| --- | --- |
| webhook 扫掠 916.0 次/天 | 1959 MB |
| cron 扫掠 289.1 次/天 | 618 MB |
| manual + inbox_refresh 16.3 次/天 | 35 MB |
| 浏览器（274 kB × 60 请求/小时，按每天前台 2 小时估） | 986 MB |
| **合计** | **≈ 3.60 GB/月（72% 额度）** |

浏览器那一行依赖「每天前台 2 小时」这个假设，未实测；其余三行由 `reconciliation_runs` 频率 × 实测 71.3 kB 推算。6.28 GB 是三刀之前的账单实测值，不能直接和本表比较。

### A1：pg_cron reconcile `*/5` → `*/30`（已完成，提交 `e65daa6c`）

- **改哪里**：[`db/migrations/033_relax_reconciliation_clock.sql`](../db/migrations/033_relax_reconciliation_clock.sql)，`cron.unschedule('pr-helper-reconcile')` 后重新 `cron.schedule` 为 `*/30 * * * *`。按 AGENTS.md 第 7 条，030 未被修改。
- **收益**：289.1 → 48 次/天，**−515 MB/月**。
- **代价**：webhook 丢投递时的兜底延迟从 ≤5 分钟变成 ≤30 分钟。
- **附带检查**：`.github/workflows/reconcile-pr-helper.yml` 的 `*/10` 兜底也在调 `/api/cron/reconcile`，pg_cron 拉长后它的相对占比会变大，需要一并决定是否放宽。
- **执行方**：迁移由使用者自己应用，不由本流程代跑。

### A2：跳过不可能改变合并判定的 CI 事件（已完成，提交 `9e11bce8` + `b51bcaed`）

- **改哪里**：新增 `webhookCanChangeStageState(eventName, action)`，在 [`api/github/webhook.ts`](../api/github/webhook.ts) 里并进 `shouldReconcile`。跳过 `check_run.created` 与 `workflow_run.in_progress` 的扫掠，**仍然记录 delivery**，只是不触发 `reconcileRealtime`。注意不能用 `webhookBranchesForEvent` 返回空数组来实现——空数组在 JS 里是真值，会照样进 `reconcileRealtime` 并付掉那次全表读。
- **保留**：`workflow_run.requested`（部署 run 行首次出现）、`check_run.completed`、`check_suite.completed`、`workflow_run.completed`、`status`、`push`、`pull_request.*`。
- **收益**：298.4 次/天不再扫掠，**−638 MB/月**。
- **代价**：零功能损失，依据见上文 `deploymentRunState` 的核对。
- **测试**：按 AGENTS.md 第 2 条先写失败单测——断言这两种 event+action 组合不产生扫掠，且上面「保留」那一列仍然产生扫掠。

### A3：浏览器轮询改为聚焦触发（已完成，提交 `208d5c5f` + `538a33eb`）

- **改哪里**：[`src/main.ts`](../src/main.ts) 删掉首页与详情页两处 `setInterval`，连带 `pollTimer` / `overviewPollTimer` / `POLL_INTERVAL_MS` / `stopOverviewSnapshotPolling` 及两处 `clearInterval` 一并移除，只保留既有的 `focus` / `visibilitychange` 监听。`startOverviewSnapshotPolling` 改名为 `bindOverviewSnapshotRefresh`，并用新的 `overviewSnapshotRefreshed` 布尔量接替原先由定时器句柄兼任的「每次进入首页只加载一次」职责——`overview()` 每次渲染都会调用它，缺了这个守卫会变成每渲染一次读一次。
- **收益**：按每天 30 次聚焦估算，986 → 247 MB，**−739 MB/月**。
- **代价**：**这是本轮唯一真实的体验代价**——看板不再自行刷新，必须切回标签页或点手动刷新才更新。对「推完 commit 去做别的事、回来看结果」的用法可以接受，但需要使用者确认。
- **备选**：若不接受，退一步把 `POLL_INTERVAL_MS` 从 60 秒改成 120 秒，收益减半（约 −493 MB）而体验损失小得多，改动只有一行。

### 合计

**3.60 → 1.71 GB/月（72% → 34% 额度）**，留出约 3 倍余量，宽限期 2026-09-20 之前无需启用按量付费或升档。

### 不做：更激进的门禁事件裁剪

再砍掉 `check_run.completed`（168.0）和 `workflow_run.completed`（114.4），只留 `check_suite.completed` + `status` 作为门禁信号，可再省 617 MB，降到约 1.09 GB/月（22%）。

**不推荐。** 风险是：能否只靠 check_suite 覆盖门禁，取决于各仓库的 required checks 是通过 check_run 还是 status 上报。若某个必需检查不在 suite 聚合里，自动合并会漏掉绿灯、退化成等兜底扫掠。用 600 MB 换「自动合并可能漏绿灯」不划算——那是产品核心功能。若日后要做，前置条件是先核一遍所有在用仓库的 required checks 配置。

### 与第四步（`/api/board`）的关系

A3 落地后，浏览器侧月出站降到约 247 MB，第四步（把 143 kB 历史数据从轮询里摘出去）能省的绝对值随之变得很小。**第四步的优先级因此进一步下降**，除非将来要面向多用户开放——那时按《实测：三刀落地后的对比》的口径，历史段那 ~107 kB 是与用户数据量无关的人均地板，会成为多租户下的主要成本。

### 多用户场景下真正的阻塞

需要记录在案：`:2121` 的全表读在多用户下是**平方级**的——扫掠次数随流程总数增长（webhook 主导），每次读取量也随流程总数增长。10 万日活 × 20 流程 = 200 万行时单次扫掠约 4 GB，函数会先超时，出站量根本轮不到成为第一个坏掉的东西。A1 / A2 只降低频率，**没有修正这个读取模式**。把过滤和批量下推到 SQL 是对外开放前的硬前置，与本轮三项独立。

## 第三轮：把过滤与批次下推到 SQL（O(U²W) → O(U)）

> 2026-08-21 评估并落地。这一轮与 A1 / A2 / A3 的性质不同：前两轮降的是**频率**，这一轮改的是**读取模式**。它是对外开放前的硬前置，单用户下收益有限。

### 实测：payload 规模与过滤选择性

| 指标 | 值 |
| --- | --- |
| workflow 行数 | 35（1 个用户） |
| payload 平均 JSON 字节 | 2014 B（最大 5043 B） |
| 全表读一次 | 约 71 kB |
| 不同仓库数 | 33 |
| 每仓库平均 workflow 数 | **1.06（最大 3）** |
| archived 占比 | 0 |
| 有 stage 以 `main` 为 target | **32 / 35** |

最后两行决定了这一轮该做哪一半、不该做哪一半。

### 成本模型

两个读点都是全表：`reconcileWorkflowStages`（[`api/_lib/workflows-store.ts:2121`](../api/_lib/workflows-store.ts)）与 `projectPullRequestWebhook`（[`api/_lib/workflows-store.ts:1507`](../api/_lib/workflows-store.ts)），都先 `SELECT ... payload ... JOIN pr_helper_users` 不带 WHERE、不带 LIMIT，再在 JS 里过滤。

设用户数 `U`、人均流程 `W`、单 payload `p ≈ 2 kB`：

- **单次全表读 = U × W × p**，与「是谁触发的」无关——任何人的一次 push 都要读所有人的所有 payload。
- **每天扫掠次数 ≈ 618 × U + 48**，webhook 部分随用户线性增长（618 为 A 轮后的单用户预估），cron 那 48 次是全局的。

两者相乘即 **O(U² × W)**。

| 规模 | 单次读 | 每天扫掠 | 月出站量 |
| --- | --- | --- | --- |
| 1 用户 / 20 流程 | 40 kB | 666 | 0.8 GB |
| 100 用户 / 20 流程 | 4 MB | 61,848 | 7.4 TB |
| 1,000 用户 / 20 流程 | 40 MB | 618,048 | 742 TB |

1,000 用户时是每秒 7 次、每次读 40 MB：函数会先超时、连接池（`max: 4`）会先耗尽，**账单不是第一个坏掉的东西**。这与《多用户场景下真正的阻塞》一节的结论一致。

### 修正后的成本

webhook 每次都携带 `repository` 与 `installationId`（[`api/github/webhook.ts:40`](../api/github/webhook.ts)），两者当前都在 JS 里判：`installationId` 本来就是列（`users.github_installation_id`），`repository` 是 `payload->>'repository'`。由于**每仓库只有 1.06 个 workflow**，把这两个条件下推后单次读从 35 行降到约 1 行，**且不再随 U 或 W 增长**。

| 规模 | 月出站量（修后） | Supabase 成本 |
| --- | --- | --- |
| 100 用户 | 7.4 GB | Pro $25（含 250 GB） |
| 1,000 用户 | 74 GB | Pro $25 |
| 10,000 用户 | 740 GB | $25 + 490 GB × $0.09 ≈ $69 |
| 100,000 用户 | 7.4 TB | 约 $670 |

cron 路径同理：`ORDER BY ... LIMIT 8` 下推后全局每月约 23 MB，可忽略。

**真正买到的是复杂度从 O(U²W) 降成 O(U)，不是省下几个 GB。**

### 改动范围（已完成）

1. `reconcileWorkflowStages`（`:2121`）：加 `WHERE payload->>'archived' IS DISTINCT FROM 'true'` 及 repository / installation 条件；cron 路径加 `ORDER BY (reconcile_pending_since IS NULL), reconcile_pending_since, last_reconcile_attempt_at NULLS FIRST LIMIT 8`；realtime 路径的 pending 补扫拆成第二条窄查询。
2. `projectPullRequestWebhook`（`:1507`）：加 repository 与 archived 条件。
3. 新迁移（034）：`(payload->>'repository')` 表达式索引。

按 AGENTS.md 规则 2，两处读点各自先写失败测试再实现：迁移 `7b3a7e03`，扫掠 `de880223` + `a1054240`，PR 投影 `1a88e082` + `dfc9491c`。

### 实施中的两个发现

**批次下推不能施加于分支收窄的扫掠。** 最初的设计只按 `trigger === 'cron'` 决定是否带 `LIMIT`，但 SQL 的 LIMIT 在分支过滤**之前**生效——若某次 cron 调用带了 `branches`，这 8 个名额会被随后被分支条件丢掉的行占满，导致本该校准的流程一轮都轮不到。实现改成 `const boundedInSql = trigger === 'cron' && !filter.branches`。当前唯一的 cron 调用方 [`api/cron/reconcile.ts:14`](../api/cron/reconcile.ts) 传的是 `{}`，所以这是防御性的，但 `trigger` 的默认值就是 `'cron'`，条件必须写明。

**`selectReconciliationBatch` 保留调用。** SQL 已经限到 8 条，该函数因此退化为按原序透传。删掉它会连带失去它的单测（即《风险》里那条「可测性下降」真正会发生的地方），保留调用则让排序语义仍有纯函数测试守着，而 SQL 的 `ORDER BY` 由源码形状测试守着，两层都在。

### 风险

- **批次排序的 tiebreak 会变。** `selectReconciliationBatch`（`:2076`）当前用原数组下标兜底，SQL 需换成显式 `user_id, id`。行为差异很小但真实存在。
- **可测性下降。** `selectReconciliationBatch` / `mergeCatchUpCandidates` 现在是纯函数且有单测覆盖，逻辑搬进 SQL 后出了单测射程，需要改用集成或源码形状测试。这是真实代价。
- **payload 结构校验留在 JS。** SQL 判不了 `isStoredWorkflow`，畸形行会被选中后再在 JS 丢掉，可能白占一个 LIMIT 名额。影响可忽略。

### 不做：把分支条件下推到 SQL

`filter.branches` 不下推，理由是实测数据而非工程偏好：

- **32 / 35 个 workflow 有 stage 以 `main` 为 target**，而 `reconciliationBranchScope`（`:1177`）遇到 target 命中即返回 `'all'`。因此一个碰到 `main` 的投递选择性约 91%，等于没筛。
- repository 条件已把结果压到约 1 行，再窄没有空间。
- 代价却是要在 SQL 里重写一遍 `branchRuleMatches`（`:1131`）的通配语义（`foo*` 前缀匹配），两份实现必然漂移。

**收 97%，放掉最难的那 3%。**

## 推荐实施顺序

> 2026-08-21 按实测字节数重排。原顺序（`/api/board` 优先）已作废，理由见《实测：一次 `/api/inbox` 的出站字节》。

**第一刀 B（已完成，提交 `1e5c6758`）：详情页轮询隐藏即停 + 间隔改 60 秒。** 首页 `refreshOverviewSnapshot` 早已自带可见性判断，无需改动；缺的是详情页 [`src/main.ts:2140`](../src/main.ts) 的 `pollTimer`，现在 tick 前先判断 `document.visibilityState === 'visible'`。两屏共用常量 `POLL_INTERVAL_MS = 60_000`。收益：详情页挂后台归零，前台从 70 MB/小时 降到约 **35 MB/小时**。原有的 `visibilitychange` / `focus` 监听保留为「回到前台立刷一次」，定时器本身不停，因此不存在回到前台后不再轮询的问题。

**第二刀 A（已完成，提交 `2b81be2c`）：请求内去重。** [`api/[action].ts`](../api/[action].ts) 建一个按请求的 memo（`VisibleWorkflowReads`）传进那 5 个 / 2 个 list 函数，`pr_helper_workflows.payload` 与 `workflow_stage_states` 各只读一次。**省 283 + 32 kB / 次**，接口形状、UI 和轮询语义全不变。这些 list 函数的可选参数不传时保持原行为，其他调用方（详情页、抽屉）不受影响。

**第三刀（已完成，提交 `98b5d245`）：去掉没人读的 `stage_snapshot`。** `listWorkflowRuns` 每次返回 50 行都带这个 jsonb，浏览器却只在类型里声明过、从不读取。两处 `INSERT` 保留，列和历史数据都还在。省 4.7 kB / 次。

三刀合计：单次 594.3 → 274.0 kB（**−53.9%**），前台 71.3 → **16.4 MB/小时**（约为原来的 **23%**），详情页挂后台归零。逐项对比见《实测：三刀落地后的对比》。（首版写的「→ 9 MB/小时、1/8」把「消除挂机流量」重复计入了首页，中间一版的「18 MB/小时」是未计入第三刀的估算，均已按实测更正。）这足以把一个完整账单周期压回 5 GB 以内。

**其余按需再做，不预先承诺：**

**第二轮 A1 / A2 / A3（已完成，提交 `e65daa6c` / `9e11bce8` + `b51bcaed` / `208d5c5f` + `538a33eb`）**：见《第二轮：按真实需求降配》。按 A1 → A2 → A3 拆成三个独立提交；A1 的迁移由使用者自己应用。三项合计把 3.60 GB/月 压到约 1.71 GB/月。A2 零功能损失，A3 需要先确认「看板不自动刷新」可接受，否则退化为把 `POLL_INTERVAL_MS` 改成 120 秒。

**第三轮（对外开放前的硬前置，已完成，提交 `7b3a7e03` / `a1054240` / `dfc9491c`）**：把 `:2121` 与 `:1507` 的全表读改成 SQL 侧过滤 + 批量，范围、成本模型与风险见《第三轮：把过滤与批次下推到 SQL》。与前两轮独立，不降低频率而是修正读取模式；多用户下这是平方级增长的来源。单用户下收益有限，因此不必赶在宽限期之前做。

3. 首页自动化动作改为摘要，不读取历史（当前 `unfinishedOnly` 已经在做，`AUTOMATION_ACTION_VIEW_LIMIT` 值得复核）。
4. 把历史数据从轮询里摘出去（events / timeline / runs / deployment_runs 共 143 kB，24%）——即原方案的 `/api/board` 与按需加载。**收益最小、改动最大**；A3 落地后浏览器侧只剩约 247 MB/月，此步优先级进一步下降，除非要面向多用户开放。
5. 增加 board version / ETag，空变化返回极小响应。
6. 建立服务端 board projection 表。
7. 补齐历史数据分页与保留策略。
8. 加入多用户下的 reconciliation lock、限流和 GitHub API 预算。

## 验收标准

三刀完成后（可直接量化，不需要等账单周期）：

- 详情页隐藏时不产生任何 `/api/inbox` 请求（DevTools Network 观察，或看 Vercel 函数调用数）；首页隐藏时本来就没有。
- 前台轮询间隔为 60 秒，回到前台立即刷新一次。
- 单次 `/api/inbox` 的数据库出站字节约降一半（实测 594.3 → 274.0 kB）；`pr_helper_workflows` 在一次请求内只被查一次。
- 首页看板、失败中心、时间线、抽屉的显示内容与改前完全一致（去掉的只有重复传输、请求次数和无人读取的 `stage_snapshot`）。
- Supabase Usage 的 Egress 日增量明显下降；连续观察一周后再判断是否需要第 4 步。

第二轮 A1 / A2 / A3 的验收标准：

- **A1**：`SELECT schedule FROM cron.job WHERE jobname = 'pr-helper-reconcile'` 返回 `*/30 * * * *`；`reconciliation_runs` 中 `trigger = 'cron'` 的日频次从约 289 降到约 48。
- **A2**：`github_webhook_deliveries` 仍然记录 `check_run.created` 与 `workflow_run.in_progress`（投递不丢），但 `reconciliation_runs` 中 `trigger = 'webhook'` 的日频次从约 916 降到约 618。部署卡片仍能在 run 开始时显示 pending 与链接（由 `workflow_run.requested` 提供）。
- **A3**：详情页与首页在前台停留时不再产生周期性 `/api/inbox` 请求；切走再切回时恰好产生一次；手动刷新仍然工作。
- **端到端**：在沙箱仓库（`bayernjf/pr-helper-e2e-sandbox` 或其 private 版本）推一次达到阈值的 commit，确认 PR 仍在秒级自动创建；CI 转绿后确认仍自动合并，且不需要页面处于前台。
- **账单**：连续观察一周 Supabase Usage 日增量，目标是折算到约 1.7 GB/月量级。

第四步（`/api/board`）若日后实施，验收标准为：- 首页轮询响应体不再包含 timeline、deployment runs、workflow runs、operation audit 和已完成自动化历史。
- 普通自动轮询不触发 GitHub reconciliation。
- 手动刷新仍能更新 GitHub 状态。
- 详情页和抽屉中的历史数据功能不丢失。
- 本地测试和生产观察均显示 `/api/board` 平均响应体显著小于当前 `/api/inbox`。

第二阶段完成后：

- 无状态变化时，轮询响应接近空 body 或 304。
- 多个打开的标签页不会产生重复校准。
- Supabase Egress 在连续运行一周后明显下降。

第三轮（SQL 下推）的验收标准（迁移 034 应用后核对）：

- 一次 webhook 触发的校准只读取该仓库相关的 workflow 行，而非全表：`EXPLAIN (ANALYZE)` 显示走 `(payload->>'repository')` 索引，`rows` 在个位数。
- cron 扫掠单次读取行数等于 `RECONCILE_WORKFLOW_BATCH_SIZE`（当前 8），不再是全表行数。
- 批次轮转仍然公平：`reconcile_pending_since` 非空的流程优先，其次按 `last_reconcile_attempt_at` 由旧到新，从未校准过的排最前。
- archived 流程仍然完全不参与任何扫掠。
- 沙箱端到端：达到阈值的 commit 仍在秒级自动创建 PR，CI 转绿后仍自动合并。
- 单次全表读的 71 kB 不再随流程总数增长——增加流程数后重测单次读取字节应基本持平。

## 临时运营建议

在第一刀 B 上线前：

- 不要把流程详情页长时间挂在后台标签里——B 上线前它每 30 秒仍在拉整份 588 kB（首页不受影响，本来就会暂停）。B 上线后这条自动失效。
- 宽限期到 2026-09-20。在 B + A 上线并观察一周之前，临时启用 Supabase 按量付费或升一档是保底手段而非替代方案，用来避免 402 打断生产。
- 优化上线后观察一个完整账单周期，再决定是否需要继续降频或升级套餐。
