# Supabase Egress 与多用户扩展方案

> 创建日期：2026-08-21
> 最后更新：2026-08-22（第四轮收缩迁移 040 已应用并实测；第六轮 ④ 放弃并新增《兜底周期的规模化》占位）
> 适用范围：PR Helper 的 Supabase 出站流量、看板轮询、状态投影、历史数据读取和多用户扩展。
> 当前状态：三刀已落地（`1e5c6758` / `2b81be2c` / `98b5d245`）；第二轮 A1 / A2 / A3 已落地（`e65daa6c` / `b51bcaed` / `538a33eb`）；第三轮（SQL 下推）已落地并**已部署生产**（`613fd350`），迁移 034 已应用，索引命中已实测；A1 的收敛阈值回归已处置（`STAGE_UNCONVERGED_THRESHOLD_SECONDS=9000`）。第三轮之后投影约 **0.38 GB/月**（1.71 GB 是第二轮的数字，见《第三轮之后的投影重算》）。执行顺序为 **6③ → 4 → 5 → 6④**：6③ 已落地并部署；第四轮已完成——服务端水合先行落地，收缩迁移 **040 已于 2026-08-21 应用**，内联提示词 42 → 0，全表 payload 读 70 837 → 28 421 B（**−59.9%**）；第五轮 036–039 已落地（`payload` 列的删除仍挂着，是独立一步）；**6④ 已放弃**（2026-08-22，理由见该节开头），轮转周期问题另立《兜底周期的规模化》占位。**至此出站量化债收口，剩余待办只有 `payload` 列删除与 `version` 乐观锁两项独立步骤。**

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

建议默认策略：（**已被 A3 取代**：`538a33eb` 把两屏的轮询时钟整个删掉，只留回到前台与用户动作触发，因此下面的「60 秒」「暂停轮询」「指数退避」是当时的设计稿，不再是现状。）

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

#### 生产实测：生效时刻与真实收益（2026-08-21）

`reconciliation_runs` 按小时聚合给出精确断点：最后一次 `*/5` 落在 **05:20:03 UTC**，此后只剩 `:00` / `:30` 两拍。cron 触发从稳定的 **13–14 次/小时降到约 3.5 次/小时**，日频次 **约 336 → 约 84**。

比预测的 48 次/天高，因为 `.github/workflows/reconcile-pr-helper.yml` 的兜底仍在跑。它声明 `*/10`，但 `gh run list` 显示 GitHub 对 schedule 事件限流，**实际间隔 30–60 分钟**、约 1.5 次/小时。所以 84 ≈ pg_cron 48 + Actions 36。上面《附带检查》里那条「是否放宽 Actions 的 `*/10`」因此没有实际意义：它已经被 GitHub 自己限流到比 `*/30` 还慢。

#### 部署后发现的回归：45 分钟收敛阈值变成结构上不可达

A1 只改了时钟，没有改依赖时钟的告警阈值，结果 `/api/cron/health` 开始持续返回 503，`reconcile-pr-helper.yml` 每次报红（`06:42:55` 那次的错误是 `/api/cron/health returned 503`）。

**根因是轮转算术，不是收敛故障**（`stages_failed` 全程为 0）：

| 量 | 值 | 来源 |
| --- | --- | --- |
| 活跃流程 | 35 | `pr_helper_workflows` |
| 每次 cron 领取 | 8 | `claimed_workflow_ids` 长度恒为 8 |
| 轮完一圈需要 | 4.4 次 sweep | 35 ÷ 8 |
| cron 频次 | 3.5 次/小时 | 上一节实测 |
| **一圈周期** | **约 75 分钟** | 4.4 ÷ 3.5 |
| 旧阈值 | 45 分钟 | `STAGE_UNCONVERGED_THRESHOLD_SECONDS` 默认 2700 |

033 之前 `*/5` 是 12 次/小时，一圈 22 分钟，45 分钟阈值有两倍余量——阈值正是按那个时钟校准的。改成 `*/30` 后一圈必然 > 45 分钟，实测最老投影年龄一路涨到 **6459 秒（108 分）、61 个阶段里 40 个超阈值**（108 = 75 + 一次撞预算的重复领取）。

**曾经想错的修法：把批次从 8 调大。** 数据否掉了它——真正的卡点是 40 秒预算（`CRON_RECONCILE_BUDGET_MS = AUTOMATION_FUNCTION_CEILING_MS - 20_000`，而 `vercel.json` 的 `maxDuration` 是 60）。`06:43` 那次已经用 44.9 秒撞线，`error_message` 为「校准未在预算内完成，已让给下一次触发」。**8 个流程就已经装不下一次预算**（可展开成 28 个阶段、218 次 GitHub 调用），调大批次只会更早撞线、丢掉更多已完成的工作。

**实际处置：重新校准阈值，不动时钟也不动批次。** Vercel Production 加环境变量 `STAGE_UNCONVERGED_THRESHOLD_SECONDS=9000`（150 分钟 = 一圈 75 分钟 + 一次浪费的槽位 + 40% 余量）。

这不是挪球门柱，依据是《需求澄清：事件驱动，不是无人值守》那一节：真实工作走 webhook 路径（当天实测 5 次全部 ≤9 秒完成），cron 扫掠只是兜底，它的一圈周期本就该是分钟到小时级。阈值应该量「兜底轮转有没有停」，而不是「有没有比 45 分钟快」。

生效方式值得记一笔：面板 Redeploy 会被拒绝（`Prebuilt deployments cannot be redeployed because they will not use the latest environment variables`），因为生产部署是 Actions 构建产物后上传的 prebuilt。正确路径是 `gh workflow run deploy-vercel.yml --ref main`——该工作流第一步就是 `vercel pull` 拉最新环境变量，再 `vercel build --prod`。

处置后实测：

| 指标 | 处置前 07:17 | 处置后 07:35 |
| --- | --- | --- |
| 最老投影 | 6459s（108 分） | 3913s（65 分） |
| 平均 | 2663s（44 分） | 1021s（17 分） |
| 超阈值阶段 | 40 / 61 | 0 / 61 |
| `reconcile-pr-helper.yml` | failure | success |

**遗留的真正瓶颈（未处理）**：每个阶段约 7.8 次 GitHub 调用（218 ÷ 28），`github_ms` 52.9 秒 > 墙钟 24.6 秒说明已经并行，所以一圈的长度由 GitHub 往返决定。降这个数才能真正缩短轮转，属代码工作，未立项。另有一处小浪费：撞预算的 sweep 似乎没有推进那批流程的 `last_reconcile_attempt_at`，导致 `06:43 → 07:00` 领取了完全相同的 8 个流程，白烧一个槽位。

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

### 部署后实测：索引在生产被命中（2026-08-21）

代码经 PR #305 / #306 进入 `main`（`613fd350`，07:12:05 UTC）并部署。`pg_stat_user_indexes` 给出比 `EXPLAIN` 更直接的证据——它统计的是真实流量，不是一次假设查询：

| 索引 | `idx_scan` | `idx_tup_read` | 折算 |
| --- | --- | --- | --- |
| `pr_helper_workflows_repository_idx` | 12 | 28 | **2.3 行/次**（旧读法 35 行） |
| `pr_helper_workflows_reconcile_pending_idx` | 4 | 75 | `ORDER BY` 下推生效 |
| `pr_helper_workflows_reconcile_attempt_idx` | 6 | 275 | 同上 |

单次 webhook 投影读 **35 → 约 2.3 行，减少 93%**，与「1.06 流程/仓库」的选择性预测一致。原验收标准要求跑 `EXPLAIN (ANALYZE)`，但只读通道拒绝 `EXPLAIN`（`read-only runner: only SELECT allowed`），且 35 行规模下 Seq Scan 本来就是正确计划；索引统计绕过了这两个问题。

无回归：部署后 webhook 5 次 success（各重算 1 个阶段）、11 次 skipped、`stages_failed` 全 0、最慢 9 秒。

**归属更正**：cron 日频次 `~336 → ~84` 是 **A1（033 的时钟）** 的收益，不是第三轮的。第三轮只降单次读取的字节，不改任何触发频率。原《验收标准》把 cron 频次列在第三轮名下，属误记。

## 数据建模债：`payload` 是前端对象的整体序列化

> 2026-08-21 记录。前三轮砍频率、第三轮砍范围，都没有触及这一层；它是「当时正确、规模变了才成为债」的典型，不是失误。

### 现状

```sql
CREATE TABLE pr_helper_workflows (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES pr_helper_users(id),
  payload jsonb NOT NULL,        -- 全部业务数据都在这一列
  created_at timestamptz, updated_at timestamptz,
  PRIMARY KEY (user_id, id)
);
```

见 [`db/migrations/001_users_and_workflows.sql:10`](../db/migrations/001_users_and_workflows.sql)。整张表只有 `user_id` 与 `id` 是真正的列；流程名、仓库、每个 stage 的源/目标分支、自动化开关、AI 提示词、部署配置、重试策略全部在 `payload` 里。而 `payload` 装的不是为数据库设计的结构，是前端 `Workflow` 对象（[`src/lib/workflow.ts:26`](../src/lib/workflow.ts)）的整体序列化。

### 三个后果

**一、数据库查不了。** 「哪些流程涉及分支 X」这个问题埋在 `payload->'stages'` 数组里，而且 `source` 可以是 `feature/*` 通配规则。第三轮只能给 `repository` 加表达式索引，因为它恰好在顶层且是等值比较；分支条件被明确放弃下推，根因就在这里。

**二、改一个字段要重写整行。** 改一个自动化开关也要读出整条 payload、改完整条写回。实测某条 payload 的 `version` 已是 86，即被整体重写过 86 次。

**三、同一份数据存了很多遍。** 实测：

| 指标 | 值 |
| --- | --- |
| 全表 payload | 71 kB / 35 行 |
| `generationRule.content` 副本数 | 44 |
| 其中不同内容的份数 | **1** |
| 副本合计字节 | 43 kB |
| 占全表 payload | **61%** |

61% 是保守下限——JSON 里 `\n` 转义成两个字符，线上实际字节更多。一份 3 stage 的真实 payload 把同一段提示词一字不差地存了三遍。

### 化债的工作量基准（实测）

- 10 处 `SELECT` 读 `payload`，9 处 `INSERT` / `UPDATE` 写 `payload`。
- `storedWorkflowFromPayload` 只在 `api/_lib/workflows-store.ts` 与 `api/_lib/preflight.ts` 被调用，解析入口是收敛的。
- `workflowSaveConflicts`（[`api/_lib/workflows-store.ts:1395`](../api/_lib/workflows-store.ts)）的乐观锁依赖 `payload` 内的 `version`，拆表时它必须先提成列。
- AGENTS.md 规则 1 规定 `src/lib/workflow.ts` 是真相来源，任何拆表都不能让服务端出现第二套互相漂移的定义。

## 化债方案

分两轮，**第四轮可以单独做，不依赖第五轮**。

### 第四轮：提示词去重（局部改动，收益 63%）

新增一张小表，把重复的内容存一次：

```sql
CREATE TABLE pr_helper_generation_rules (
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  content_hash text NOT NULL,          -- sha256(content)，天然幂等
  name text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, content_hash)
);
```

stage 里的 `automation.generationRule` 从 `{ name, content, capturedAt }` 改为 `{ name, contentHash, capturedAt }`。

**关键约束（实测得出）**：44 个 stage 的 `capturedAt` 有 44 个不同值——它是每个 stage 独立的快照时间，**必须留在 stage 上**，只有 `content` 能去重。整体替换 `generationRule` 会丢掉这个信息。

- **收益**：单次全表读 70 837 B → 约 26 kB（−63%，2026-08-21 复测：44 个阶段**全部**带 `generationRule`，`content` 只有 1 份不同内容却占 44 528 B）。第三轮之后 webhook 路径已只读 1~3 行，所以这一轮在单用户下约 119 MB/月（浏览器 39 + webhook 45 + manual 21 + cron 14）；多用户下它与用户数成正比。
- **实现约定**：hash 用 `createHash('sha256').digest('hex')`，与 [`api/_lib/ai-credentials.ts:39`](../api/_lib/ai-credentials.ts) 既有写法一致；迁移里的回填用 `digest(content,'sha256')`（pgcrypto 1.3 已装，需按 Supabase 的安装位置限定 schema）。payload 的读点共 10 处（`:533 :1200 :1247 :1328 :1407 :1459 :1489 :1510 :2139 :2344`），写点 2 处（`:1417` INSERT、`:1470` UPDATE），其余对 `pr_helper_workflows` 的 UPDATE 只动 `last_reconcile_attempt_at` / `reconcile_pending_since`，不受影响。
- **过渡期兼容**：读路径先取 `contentHash`，取不到时回退读内嵌 `content`；写路径只写 `contentHash`。回填完成后再删除回退分支。
- **风险**：入队时要把内容取出来交给 AI（[`api/_lib/workflows-store.ts:102`](../api/_lib/workflows-store.ts) 与 `:156` 的 `generationRule: input.generationRule` / `automation.generationRule.content`），取不到内容会让自动创建 PR 静默失败。按 AGENTS.md 规则 2，先写「内容缺失时入队必须报错而不是写空规则」的失败测试。
- **不受影响**：自动化 drain 读的是 `payload->'recoveryPolicy'->>'cooldownSeconds'`，与提示词无关。
- **验收**：单次全表 payload 字节降到约 28 kB；沙箱仓库端到端仍能生成带正确标题与描述的 PR；`pr_helper_generation_rules` 行数远小于 stage 数。

#### 收缩（040，2026-08-21 写好，等应用）

035 之后 payload 里不再写 `content`，但**脱水只在保存时触发**：2026-08-21 实测 42 / 44 个 stage 从未再保存过，仍内联着整份提示词，而这 42 份是**同一份内容**、且已在 `pr_helper_generation_rules` 里（去重后 distinct = 1，1 004 B）。所以 040 只做一件事：把 payload 里的 `content` 换成 `contentHash`。

落地顺序（已按此执行）：

1. **先补服务端水合**（`42bcb23b`，已部署并在生产验证）。浏览器对只有 hash 的 stage 是**按名字**从本地 localStorage 规则列表找回内容（[`src/lib/generation-rules.ts:147`](../src/lib/generation-rules.ts)），本地没有同名规则就当作「没有规则」，再保存一次 automation 就把策略静默丢了。所以列表读加 `hydrateGenerationRules`：按 `(user_id, content_hash)` 一次查回内容填进 payload 派生的 workflow，代价是每请求多读该用户的规则行（当前 1 行）。键必须带 `user_id`——共享流程的规则属于流程拥有者，用读者的 id 去查会填错内容。生产验证：两个已脱水 stage 的 `content.length` 均为 1 004。
2. **再应用 040**（`7b6efab6`）。三段：重跑 035 的回填（让守卫恒真）、按 stage 改写 payload、最后一段 `DO $$` 在「仍有内联内容且内容表解不出来」时 `RAISE EXCEPTION`。改写带两条硬约束：**每个 stage 自带 `EXISTS` 守卫**（内容表没有的内容一旦删掉找不回来），以及 **`jsonb_agg ... ORDER BY ordinality`**（stage 顺序就是流程顺序，无序重组会把 `dev → main` 排到它的上游前面）。
3. **可回滚**：内容仍在 `pr_helper_generation_rules`，反向 UPDATE 就能写回内联。这是敢做 040 的全部依据。

**明确不碰的三处**（各有理由，不要顺手加进来）：

- `workflow_automation_runs.workflow_snapshot`（432 行 / 683 kB，426 行含内联）：**已入队动作自己的提示词副本，drain 要读**，改它会打断在途动作。
- `workflow_versions.snapshot`（2 002 行 / 2.4 MB，942 行含内联）：全代码库**没有任何读者**（`WorkflowVersion` 类型已死，只写不读），删它省不到出站量；且 035 之后写入的快照本来就是脱水的。
- `pr_helper_workflows.payload` **列本身**：仍有 14 处读点在解析它，删列是独立的一步，不欠这一轮。原先「第五轮 `payload` 列删除并入第四轮 contract」的安排**撤回**，理由见《读切换之后：为什么 039 的代码半不做》。

### 第五轮：拆成关系表（终局，对外开放前）

目标结构：

```sql
workflows        (user_id, id, name, repository, archived, version, position, ...)
workflow_stages  (user_id, workflow_id, stage_id, stage_index, source_rule, target,
                  auto_create, auto_merge, trigger_min_commits, rule_content_hash, ...)
workflow_deployments (user_id, workflow_id, target, provider, environment, ...)
```

按 **expand → migrate → contract** 四步走，每步都可独立部署、独立回滚：

1. **加表并双写。** 新表与 `payload` 同时写，`payload` 仍是唯一真相；读路径完全不变。此步不改任何行为，只增加写入量。
2. **回填历史。** 一次性迁移把现有 payload 展开进新表，并加一个一致性校验查询（新表还原出的对象与 payload 逐字段相等）。
3. **读切换。**（2026-08-21 已落地，迁移 038）扫掠与 webhook 投影改读列而不读 `payload`；分支条件由此才能真正下推：`WHERE stages.source_rule = ANY(...)` 可走普通索引，第三轮里被放弃的那一半随之成立。`version` 提成列但**未**接入 `workflowSaveConflicts`——错误的乐观锁意味着丢编辑，这一步单独排。
4. **收缩。** 服务端不再解析 `payload`，只保留浏览器同步所需的最小载体（或彻底移除）。**范围已收窄，见下。**

#### 读切换之后：为什么 039 的代码半不做

2026-08-21 落地 038 后清点剩余 14 处 `storedWorkflowFromPayload`，结论是**代码上的 contract 基本不值得做**：

- **7 处是按主键读单个流程**（`workflowAccessForUser`、`upsertWorkflow`、`removeWorkflow`、`recordWorkflowRun` 等）。每次只读 1 条 payload（约 1.5 kB），切成列读要多打两次子表索引，省下的字节可忽略。
- **7 处是浏览器列表读**（`listWorkflows`、`listWorkflowStageStates`、`listActionableStages`、`listRecoveryStatuses`、`listWorkflowTimeline` 等）。这些是全量读，但**浏览器要的就是完整对象**——从 payload 读还是从列拼，离开 Supabase 的字节数几乎一样，`jsonb_agg` 加上每行重复的列名甚至更多。

038 有收益是因为扫掠读 35 个流程只为动其中 2 个，**杠杆在「读得多、用得少」**；列表读没有这个杠杆。所以 039 只保留一件立刻能做且安全的事：删掉已死的 `pr_helper_workflows_repository_idx`（旧 jsonb 表达式索引，切换后无任何查询引用，只剩写入开销）。`payload` 列的删除**仍然挂着**：14 处读点还在解析它，它是独立的一步，不并入第四轮 040。

**payload 为什么必须再等一段**——不是仪式，有可指名的残余风险：

- payload 目前仍是完整真相，038 的重建若有测试没覆盖到的错，`git revert` 即可恢复，零数据操作；删掉 payload 后回滚要走备份恢复。
- 线上 44 条 stage 行的 `execution_mode` **全是 `server`**（2026-08-21 实测）。映射层的 `browser-session` 分支与「只有 autoMerge」分支线上一条真实数据都没走过，只有单测覆盖。等的意义就是等这两个分支被真实流量走一遍。


- **收益**：单次扫掠字节**不再随流程总数增长**，分支条件可索引，改一个开关是一行 `UPDATE` 而非整行重写。这是把 O(U) 进一步压到「与数据量无关」的唯一途径。
- **主要风险**：`src/lib/workflow.ts` 是前后端共享的真相定义，拆表意味着服务端要有一层行↔对象映射，两边可能漂移。缓解手段是一个往返恒等测试（对象 → 行 → 对象 必须逐字段相等），并在第 2 步的校验查询里对全量数据跑一遍。
- **次要风险**：`stage_index` 与 `stageId` 的双重身份已经由迁移 018 / 019 处理过，拆表要沿用既有的稳定身份规则，不能再引入第三套。
- **工作量**：数周级，不是两天级。10 处读、9 处写全部涉及。
- **验收**：`EXPLAIN` 显示分支条件走索引；把流程数翻倍后单次扫掠字节基本持平；所有既有单测与 E2E 不变通过。

### 明确不做

- **不做一次性大爆炸迁移。** 第五轮必须按四步走；跳过双写阶段意味着一旦读切换出错就没有回退路径。
- **不做长期双真相。** 双写只是过渡态，第 4 步必须真正收缩，否则等于永久维护两套结构，比现在更差。
- **不为省 61% 而提前拆表。** 第四轮用一张小表就能拿到那 61%，与第五轮解耦；把两件事捆在一起会让一个数周级重构挡住一个数天级收益。

## 第三轮之后的投影重算

> 2026-08-21。头部原先写的 1.71 GB/月 是第二轮 A1 / A2 / A3 之后的数字，第三轮把 webhook 与 cron 的单次读从全表 71 kB 压到约 2.3 行之后没有重算，这里补上。

按 `《修正后的成本》` 的「100 用户 7.4 GB」折算到单用户：

| 项 | 第二轮后 | 第三轮后 | 伸缩性 |
| --- | --- | --- | --- |
| 浏览器轮询 | 247 MB | 247 MB | 随用户线性 |
| webhook 扫掠 | 1321 MB | ~74 MB | 随用户线性 |
| manual + inbox_refresh | 35 MB | 35 MB | 随用户线性 |
| cron 扫掠 | 103 MB | ~23 MB | 全局固定（批次恒为 8） |
| **合计** | **≈ 1.71 GB/月** | **≈ 0.38 GB/月（7.6% 额度）** | |

两个由此产生的结论：

1. **浏览器轮询现在占人均的 65%**，是唯一还值得为出站量动手的地方。第四、五轮合计只能把 0.38 压到约 0.23 GB/月（省约 150 MB，占额度 3%），5 GB 支持的活跃用户数从约 14 提到约 21。**所以这两轮不该以出站量为理由做**，理由见各自小节。
2. **A1 砍 cron 频率的定价前提已经不成立。** A1 当时每次扫掠读全表 71 kB，第三轮之后同一次扫掠只读约 16 kB，频率的单价掉了约 78%。若日后需要缩短兜底轮转周期，把时钟调回 `*/5` 的代价只是 cron 出站从 23 MB 回到约 140 MB/月（额度 2.7%）——那是重新定价，不是回退。但它只把周期除以 3，不解决下面这个 85% 的空转。

## 第六轮：兜底扫掠瘦身（③ 终结阶段短路 + ④ 只扫有活的）

> 2026-08-21 记录。这一轮和出站量无关，解决的是**兜底轮转周期**：它会在远早于 5 GB 的地方失效。

### 问题：轮转周期随流程数线性增长，而 85% 的阶段是空转

一圈周期 = `活跃流程数 ÷ 批次 ÷ cron 频次`。35 个流程时约 75 分钟（尚可）；按 21 个用户 × 35 = 735 个流程推算是**约 26 小时**，兜底形同不存在。批次调不大——8 个流程已经撞满 40 秒预算（见《部署后发现的回归》）。

阶段投影的实测分布解释了预算去哪了：

| 阶段状态 | 数量 | 其中 `ahead_by = 0` | 每次扫掠的 GitHub 调用 |
| --- | --- | --- | --- |
| merged | 43 | 42 | ~5（列 PR + PR 详情 + compare + check-runs + status） |
| closed | 6 | 6 | ~3 |
| none | 5 | 5 | ~3 |
| **open** | **8** | 0 | ~7（再加 reviews + protection + rules） |

根因在 [`api/_lib/workflows-store.ts:1549`](../api/_lib/workflows-store.ts) 的 `pullForStage` 用了 **`state=all`**：一个三个月前就合并、分支再无新提交的阶段，每一圈仍要付两次调用把那个历史 PR 取回来，再加 compare、check-runs、status。**62 个阶段里 53 个（85%）属于「已终结且分支零新增」**，它们吃掉绝大部分调用却不可能改变任何状态。这就是 7.8 次/阶段与 44.9 秒撞线的来源。

附带排除：通配 source 只有 3 个阶段，`routeSourcesForStage` 那 3 次列表调用不是主要成本，不必优先优化。

### ③ 终结阶段短路（1–2 天，无出站量代价）

把 `compare`（[`:1765`](../api/_lib/workflows-store.ts)）提到 `pullForStage`（[`:1757`](../api/_lib/workflows-store.ts)）之前。若 `ahead_by = 0` **且** 库里 `pull_state ∈ {merged, closed}` **且** 该 target 没有部署配置或部署行已终结 → 只写一次 `updated_at` 返回，跳过其余 4 次调用。

- **安全边界**：merged 阶段目前会走 `reconcileStageDeployments`（[`:1787`](../api/_lib/workflows-store.ts)）跟踪部署，短路会跳过它。按 AGENTS.md 第 2 条，先写「已终结阶段不得跳过未完成的部署跟踪」的失败测试。44 个配置阶段里有 13 个在配了部署的流程下。
- **收益**：每阶段 7.8 → 接近 1–2；一次 40 秒预算能装的流程数涨 4–5 倍；一圈从 75 分钟降到十几分钟。
- **验收**：`reconcileTimingLine` 日志里 `githubCalls` 中位数下降；cron sweep 不再出现「校准未在预算内完成」；`stages_failed` 保持 0。

### ④ 兜底只扫「可能有活」的流程（**已放弃，2026-08-22**）

> 2026-08-22 结论：**不做**。理由不是「当前只有一个用户」，而是它的单价在任何用户量下都不优，且不解决它声称要解决的周期问题。原始设计与成本模型保留在下方备查。

**放弃理由（按实测重算）**

决定性的比值是**每仓库的阶段数**，实测 **62 / 33 = 1.88**（25 个仓库 1 个阶段、7 个 2 个、1 个 5 个）。两种做法覆盖「已终结阶段」的单价：

| | 单价 |
| --- | --- |
| ⑥③ 短路（已落地） | 每个终结阶段 ~1 次 compare → 每仓库 **~1.6 次** |
| ④ 发现层 | 每仓库固定 **2 次**（branches + pulls） |

④ 只在「每仓库阶段数 > 2.4」时划算，而**用户增长不改变这个比值**——多一个用户，仓库数与阶段数同比例增长。因此：

- 1 用户：③ 一圈 ~116 次 vs ④ ~108 次；
- 21 用户：③ 一圈 ~2436 次 vs ④ ~1386（发现层）+ 活跃阶段详情层（④ 一分省不掉，8 个 open 阶段 × 7 ≈ 56/用户）≈ **~2560 次**。

任何规模下打平或略亏。根因是 ③ 已经把终结阶段压到 1 次调用，剩余成本全在真正有活的阶段上，而那部分 ④ 必须照付。

**④ 也不是规模化的答案**：现在 cron `*/10`、批次 8、单次预算 40 秒（`maxDuration: 60`）。③ 之后 735 个流程（21 × 35）批次哪怕调到 40，一圈 ≈ 735/40 × 10 分钟 ≈ **3.2 小时**；④ 之后一圈的发现层是 1386 次调用，40 秒内做不完（需 35 次/秒），文档自己给的缓解办法「轮转仓库」就是退回同一个 O(N/批次) 问题。

**重开条件**（任一成立就回来看）：`reconcileTimingLine` 再次出现「校准未在预算内完成」；活跃流程数越过约 100；每仓库阶段数中位数升到 3 以上（说明单仓库多流水线成为主流用法）。

**以下为原始设计，仅备查。**

前提：**webhook 已经覆盖 `push` 事件并带上分支**（[`api/github/webhook.ts:38`](../api/github/webhook.ts)），所以 cron 兜底唯一独有的职责是「投递丢失时补救」，不需要每圈把所有流程都问一遍 GitHub。

- **新表**：`workflow_repository_branch_tips (user_id, repository, branch, sha, observed_at)`，主键 `(user_id, repository, branch)`。
- **发现层**（每仓库 2 次调用）：`branches?per_page=100` + `pulls?state=open&per_page=100`。用分支 tip sha 与上次记录比对，得出哪些 source 分支动过。
- **详情层**：只对候选阶段跑完整的 `reconcileStageWork`。候选 = 源分支 sha 变了 ∪ 有开放 PR ∪ `reconcile_pending_since` 非空 ∪ 有未完成动作。当前符合的只有 **3 个流程**（2 个有开放 PR + 1 个有未完成动作）。
- **成本对比**：33 仓库 × 2 = 66 次调用走完一圈，取代现在「8 个流程 218 次 × 4.4 圈 ≈ 950 次」。一圈从 75 分钟变成一次 sweep。**（这个 950 是 ⑥③ 之前的基线，③ 落地后同一圈约 116 次，收益前提随之失效——见本节开头的放弃理由。）**
- **为什么排在第五轮之后**：候选集要在 SQL 里算才有意义，这需要 stage 的 source / target 已经列化。
- **代价与缓解**：发现层是 O(仓库数)，21 用户 × 33 仓库 = 1386 次调用/圈。缓解办法是**轮转仓库而不是轮转流程**，把发现层摊到多次 sweep。
- **验收**：一次 sweep 走完全部仓库的发现层；在沙箱人为制造一次「webhook 丢投递」（push 后不依赖 webhook），兜底能在一个 sweep 内发现并补上。

### 明确不做

- **不单独调大 `CRON_RECONCILE_BATCH_SIZE`。** 40 秒预算已经装不下 8 个流程，调大只会更早撞线、丢掉更多已完成的工作。只有 ③ 落地后它才有意义。
- **不把兜底的发现职责整个交给 webhook。** 兜底存在的唯一理由就是投递会丢；④ 保留发现层，只是把它从「每流程问一遍」改成「每仓库问一次」。

## 兜底周期的规模化（占位，未开始）

> 2026-08-22 新开。⑥④ 放弃后，「面向多用户时兜底一圈要多久」这个问题仍然没有答案，单独立项占位，**现在不做**。

⑥③ 之后一圈约 116 次调用 / 62 个阶段，痛点已经不是调用数而是**轮转周期**：cron `*/10`、批次 8、单次预算 40 秒，735 个流程（21 用户 × 35）即使把批次调到 40 也要约 3.2 小时一圈。⑥④ 不解决这个（理由见上节）。候选路径三条，都还没评估：

1. **重新标定批次与频次。** ③ 落地后终结阶段只花 1 次调用，40 秒预算能装的流程数已经变了，`RECONCILE_WORKFLOW_BATCH_SIZE = 8`（[`api/_lib/workflows-store.ts:2240`](../api/_lib/workflows-store.ts)）是按 ③ 之前的成本定的，需要按实测重定；cron 频次同理。
2. **按用户分片并发扫掠。** 一圈的工作量天然可按 `user_id` 切开，互不影响；瓶颈会从单次预算转移到 GitHub 每安装的速率限制，需要先测。
3. **让 webhook 投递可核对。** 持久化 delivery id，兜底只补缺口而不是重扫一遍——这是唯一能把兜底成本从 O(流程数) 变成 O(丢失投递数) 的方向，也最贴合「兜底存在的唯一理由是投递会丢」。

**启动条件**：`reconcileTimingLine` 再次出现「校准未在预算内完成」，或活跃流程数越过约 100，或出现第二个真实用户。

## 推荐实施顺序

> 2026-08-21 按实测字节数重排。原顺序（`/api/board` 优先）已作废，理由见《实测：一次 `/api/inbox` 的出站字节》。

**第一刀 B（已完成，提交 `1e5c6758`；间隔部分已被 `538a33eb` 取代）：详情页轮询隐藏即停 + 间隔改 60 秒。** 首页 `refreshOverviewSnapshot` 早已自带可见性判断，无需改动；缺的是详情页 [`src/main.ts:2140`](../src/main.ts) 的 `pollTimer`，现在 tick 前先判断 `document.visibilityState === 'visible'`。两屏共用常量 `POLL_INTERVAL_MS = 60_000`。收益：详情页挂后台归零，前台从 70 MB/小时 降到约 **35 MB/小时**。原有的 `visibilitychange` / `focus` 监听保留为「回到前台立刷一次」，定时器本身不停，因此不存在回到前台后不再轮询的问题。**后续变化**：第二轮 A3（`538a33eb`）把时钟整个删掉了，`POLL_INTERVAL_MS` 与 `pollTimer` 都已不存在（由 [`src/main-detail-refresh.test.ts`](../src/main-detail-refresh.test.ts) 断言守住），刷新只由回到前台和用户动作触发，所以本节的「60 秒」只反映当时的中间状态。

**第二刀 A（已完成，提交 `2b81be2c`）：请求内去重。** [`api/[action].ts`](../api/[action].ts) 建一个按请求的 memo（`VisibleWorkflowReads`）传进那 5 个 / 2 个 list 函数，`pr_helper_workflows.payload` 与 `workflow_stage_states` 各只读一次。**省 283 + 32 kB / 次**，接口形状、UI 和轮询语义全不变。这些 list 函数的可选参数不传时保持原行为，其他调用方（详情页、抽屉）不受影响。

**第三刀（已完成，提交 `98b5d245`）：去掉没人读的 `stage_snapshot`。** `listWorkflowRuns` 每次返回 50 行都带这个 jsonb，浏览器却只在类型里声明过、从不读取。两处 `INSERT` 保留，列和历史数据都还在。省 4.7 kB / 次。

三刀合计：单次 594.3 → 274.0 kB（**−53.9%**），前台 71.3 → **16.4 MB/小时**（约为原来的 **23%**），详情页挂后台归零。逐项对比见《实测：三刀落地后的对比》。（首版写的「→ 9 MB/小时、1/8」把「消除挂机流量」重复计入了首页，中间一版的「18 MB/小时」是未计入第三刀的估算，均已按实测更正。）这足以把一个完整账单周期压回 5 GB 以内。

**其余按需再做，不预先承诺：**

**第二轮 A1 / A2 / A3（已完成，提交 `e65daa6c` / `9e11bce8` + `b51bcaed` / `208d5c5f` + `538a33eb`）**：见《第二轮：按真实需求降配》。按 A1 → A2 → A3 拆成三个独立提交；A1 的迁移由使用者自己应用。三项合计把 3.60 GB/月 压到约 1.71 GB/月。A2 零功能损失，A3 需要先确认「看板不自动刷新」可接受，否则退化为把 `POLL_INTERVAL_MS` 改成 120 秒。

**第三轮（对外开放前的硬前置，已完成，提交 `7b3a7e03` / `a1054240` / `dfc9491c`）**：把 `:2121` 与 `:1507` 的全表读改成 SQL 侧过滤 + 批量，范围、成本模型与风险见《第三轮：把过滤与批次下推到 SQL》。与前两轮独立，不降低频率而是修正读取模式；多用户下这是平方级增长的来源。单用户下收益有限，因此不必赶在宽限期之前做。

**第六轮 ③（终结阶段短路，最先做）**：见《第六轮：兜底扫掠瘦身 · ③》。1–2 天，不涉及 payload，与第四、五轮完全解耦，解决当前唯一真实的瓶颈（兜底轮转周期）。因此从原定的第三位提到第一位。

**第四轮（提示词去重，主体已落地，收缩已就绪）**：见《化债方案 · 第四轮》。表与代码已随 035 落地并部署，扫掠 / webhook 走的关系读路径（`workflow_stages.rule_content_hash`，44/44 行有值）已不带提示词。剩下的是 payload：脱水只在保存时触发，2026-08-21 实测 42 / 44 个 stage 仍内联，因此全表读的 63%（44 528 / 70 837 B）尚未拿到——迁移 **040 已写好，等应用**。单用户下约 119 MB/月——**原先标注的「约 100 MB/月」是按第三轮之前的 cron 基线算的，已作废**；重算后的构成是浏览器 39 MB、webhook 45 MB、manual 21 MB、cron 14 MB。多用户下与用户数成正比。

**第五轮（拆成关系表，对外开放前）**：见《化债方案 · 第五轮》。数周级，按 expand → migrate → contract 四步走。**036 / 037 / 038 已于 2026-08-21 落地**，扫掠与 webhook 投影已改读列，第三轮放弃的分支条件下推随之成立；039 contract 的范围已收窄到只删一个已死索引；`payload` **列**的删除仍然挂着，是独立的一步。

**第六轮 ④（兜底只扫有活的）**：**已放弃，2026-08-22**，理由见《第六轮：兜底扫掠瘦身 · ④》开头——单价在任何用户量下都不优（每仓库 2 次 vs ③ 短路的 ~1.6 次，且这个比值不随用户增长改变），也不解决它声称要解决的轮转周期问题。周期问题另立《兜底周期的规模化》占位。

3. 首页自动化动作改为摘要，不读取历史（当前 `unfinishedOnly` 已经在做，`AUTOMATION_ACTION_VIEW_LIMIT` 值得复核）。
4. 把历史数据从轮询里摘出去（events / timeline / runs / deployment_runs 共 143 kB，24%）——即原方案的 `/api/board` 与按需加载。**收益最小、改动最大**；A3 落地后浏览器侧只剩约 247 MB/月，此步优先级进一步下降，除非要面向多用户开放。
5. 增加 board version / ETag，空变化返回极小响应。
6. 建立服务端 board projection 表。
7. 补齐历史数据分页与保留策略。
8. 加入多用户下的 reconciliation lock、限流和 GitHub API 预算。

## 验收标准

三刀完成后（可直接量化，不需要等账单周期）：

- 详情页隐藏时不产生任何 `/api/inbox` 请求（DevTools Network 观察，或看 Vercel 函数调用数）；首页隐藏时本来就没有。
- ~~前台轮询间隔为 60 秒，回到前台立即刷新一次。~~ **已被第二轮 A3（`538a33eb`）取代**：时钟整个拿掉了，两屏都只在回到前台时刷新一次，不存在间隔。验收改为下一条。
- **2026-08-22 生产实测（DevTools PerformanceObserver，详情页）**：9 分钟内 4 次 `/api/inbox`，全部 `hidden=false`，隐藏期零请求；间隔 308 s / 192 s，即每次都对应一次「切回浏览器」，证实已无时钟。单次响应体 **301.6 kB 原始 / 24.3 kB gzip**（这是服务端到浏览器的响应体，与本文其他地方的 594.3 → 274.0 kB 不是同一口径，后者是数据库到服务端）。同时暴露一个重复读：切回标签页会同时触发 `focus` 与 `visibilitychange`，两次一模一样的请求落在同一秒（`#1`/`#2` 字节完全相同），已在 `refreshStatuses` 加 in-flight 守卫修掉，用户主动触发的刷新不受影响。
- 单次 `/api/inbox` 的数据库出站字节约降一半（实测 594.3 → 274.0 kB）；`pr_helper_workflows` 在一次请求内只被查一次。
- 首页看板、失败中心、时间线、抽屉的显示内容与改前完全一致（去掉的只有重复传输、请求次数和无人读取的 `stage_snapshot`）。
- Supabase Usage 的 Egress 日增量明显下降；连续观察一周后再判断是否需要第 4 步。

第二轮 A1 / A2 / A3 的验收标准：

- **A1**：`SELECT schedule FROM cron.job WHERE jobname = 'pr-helper-reconcile'` 返回 `*/30 * * * *`；`reconciliation_runs` 中 `trigger = 'cron'` 的日频次从约 289 降到约 48。✅ 已验（2026-08-21 05:20:03 UTC 断点，日频次 ~336 → ~84，差额来自 Actions 兜底）。**追加一条**：改时钟必须同时校准 `STAGE_UNCONVERGED_THRESHOLD_SECONDS`——阈值应 ≥ 一圈周期（`活跃流程数 ÷ 批次 ÷ cron 频次`）加一次撞预算的余量，否则 `/api/cron/health` 恒 503。当前值 9000。
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

- 一次 webhook 触发的校准只读取该仓库相关的 workflow 行，而非全表。✅ 已验，但改用 `pg_stat_user_indexes` 而非 `EXPLAIN (ANALYZE)`：只读通道拒绝 `EXPLAIN`，且 35 行下 Seq Scan 本就是正确计划。实测 `pr_helper_workflows_repository_idx` 12 次扫描共读 28 行 = 2.3 行/次。
- cron 扫掠单次读取行数等于 `RECONCILE_WORKFLOW_BATCH_SIZE`（当前 8），不再是全表行数。✅ 已验，`claimed_workflow_ids` 长度恒为 8。
- 批次轮转仍然公平：`reconcile_pending_since` 非空的流程优先，其次按 `last_reconcile_attempt_at` 由旧到新，从未校准过的排最前。
- archived 流程仍然完全不参与任何扫掠。
- 沙箱端到端：达到阈值的 commit 仍在秒级自动创建 PR，CI 转绿后仍自动合并。
- 单次全表读的 71 kB 不再随流程总数增长——增加流程数后重测单次读取字节应基本持平。

第六轮 ③（终结阶段短路）的验收标准：

**部署前基线（2026-08-21 实测，`reconciliation_runs` 近 24 小时，`state <> 'skipped'`）：**

| trigger | runs | stages | github_calls | 次/阶段 | 平均耗时 |
| --- | --- | --- | --- | --- | --- |
| cron | 222 | 3094 | 19 993 | **6.46** | 14 818 ms |
| webhook | 222 | 306 | 2 891 | 9.45 | 9 445 ms |
| inbox_refresh | 1 | 2 | 20 | 10.00 | 6 613 ms |

- **主指标**：cron 的 `github_calls / stages_total` 从 **6.46** 降到约 **1.8**（85% 的阶段只剩 `compare` 一次调用，15% 仍走完整 6.46）。webhook 路径不受影响甚至更好——它扫的都是刚动过的分支，本来就不该被短路。
- 轮转周期缩短：一圈扫完 35 个流程的时间从约 75 分钟降到能在一次 cron 预算内完成大部分批次；`/api/cron/health` 不再因阈值而报 503。
- **安全边界不破**：已合并阶段若仍有未终结的部署（`deployment` 配置存在且部署行非终态），必须继续跟踪，不得被短路跳过。这条由单元测试 `已终结阶段不得跳过未完成的部署跟踪` 守住。
- **收敛时间戳不冻结**：`readConvergenceHealth` 读的是 `min(updated_at) FROM workflow_stage_states`，所以短路路径必须仍然 `UPDATE ... SET updated_at = now()`，否则健康检查恒 503。这是 A1 那类回归，已由单元测试守住。
- **计数报实话**：短路的阶段计入 `stages_reconciled`（它确实被核对过），否则 `deferredRunState` 会把整批终结阶段的扫掠误判成 `degraded`。
- 沙箱端到端：达到阈值的 commit 仍在秒级自动创建 PR，CI 转绿后仍自动合并。

第四轮（提示词去重）的验收标准：

- `pr_helper_generation_rules` 回填后，`content` 的去重率与实测一致（44 份引用 → 1 条内容）。
- payload 中不再出现 `generationRule.content`，只留 `contentHash`；单次全表读字节从 70 837 B 降到约 26 kB。
- 入队自动化时若 hash 查不到内容，必须**报错而非静默降级**——由失败测试守住。
- 收缩迁移只在读路径完全切换并观察一周后才应用。**编号已定：040**（第五轮先落地占用了 036–039，不预留空洞——仓库里没有迁移 runner，编号空洞只会让人怀疑是否漏执行）。第五轮 `payload` **列**的删除**不并入**这一步：仍有 14 处读点，删列是独立一步。
- **脱水是保存时触发的，没有批量迁移**，所以全表收益是渐进的而非上线即得：2026-08-21 实测 2 个已脱水流程共 2 508 B（均 1 254 B），另 33 个仍内联共 52 179 B（均 1 581 B），单流程约 −21%。方案里的 −63% 是按全部 44 个 stage 算的，而已脱水的两个沙箱流程各只有 1 个 stage——两个数字不矛盾，但**不要拿 63% 当上线次日的验收线**。

第五轮（拆关系表）的验收标准：

- expand → backfill → 读切换 → contract 四步各自独立可回滚；任何一步单独部署后系统行为不变。迁移编号：**036 expand（已落地）**、**037 回填与一致性校验（已落地）**、**038 读切换与索引（已落地，2026-08-21）**、039 contract（范围已收窄，见《读切换之后》）。
- 038 落地后的实测证据（读-only 通道）：`name` / `repository` / `archived` 三列均为 NOT NULL（这条 ALTER 能成功本身就证明 037 一行没漏）；新索引 `pr_helper_workflows_active_repository_idx ON (repository) WHERE archived = false` 已被使用，12 次扫描读出 27 行（均 2.25 行/次，切换前是全表 35 行）；子表走索引而非全表（`workflow_stages` idx_scan 193 / seq_scan 8）；35 个流程中 **0 个没有 stage 行**，payload 的 stage 数与行数 **0 处不一致**。
- 回填后有一致性检查：关系表重组出的对象与原 payload **逐字段相等**（round-trip identity 测试）。已由 [`api/_lib/workflow-rows.test.ts`](../api/_lib/workflow-rows.test.ts) 用 `toStrictEqual` 守住——它把 `{position: undefined}` 与 `{}` 判为不等，能抓住漏键，`toEqual` 不能。
- `version` 提升为独立列后，`workflowSaveConflicts` 的冲突检测行为与改前一致。**038 未做这一步**：列已存在并被镜像写入，但冲突检测仍读 payload。错误的乐观锁意味着丢用户编辑，故单独排一步、单独验收。
- 读切换后单次读取字节随「实际需要的字段」变化，而不再随 payload 总大小变化。
- **expand 步的两条约束**（036 已满足）：promoted 列全部可空（含类型上必填的 `name` / `repository`，因为历史行没有值可填，NOT NULL 默认值等于编造数据，要等回填后才收紧）；`declared_created_at` 与 `rule_captured_at` 存 text 而非 timestamptz，否则往返会被 Postgres 重排格式，恒等测试立刻失败。
- **镜像不漏写点**：payload 有两处写点（`upsertWorkflow` 的 INSERT 与删步骤路径的 UPDATE），两处都必须在**同一事务内**镜像，否则崩溃后两份表示不一致，正是回填校验会读成「数据损坏」的状态。由单元测试守住。

第六轮 ④（兜底只扫有活的）**已放弃，不再有验收标准**。原定标准如下，仅在满足重开条件后回看时参考：

- `workflow_repository_branch_tips` 存在且被 webhook 更新；cron 的第一层只按仓库做 tip 发现，第二层只对 tip 变化或有未终结活的流程取详情。
- 无任何变化时，一圈 cron 的 GitHub 调用数接近仓库数（而非阶段数）。
- 丢投递恢复能力不退化：人为跳过一次 webhook 投递后，下一圈 cron 仍能发现并补齐该仓库的变化。

## 临时运营建议

在第一刀 B 上线前：

- 不要把流程详情页长时间挂在后台标签里——B 上线前它每 30 秒仍在拉整份 588 kB（首页不受影响，本来就会暂停）。B 上线后这条自动失效。
- 宽限期到 2026-09-20。在 B + A 上线并观察一周之前，临时启用 Supabase 按量付费或升一档是保底手段而非替代方案，用来避免 402 打断生产。
- 优化上线后观察一个完整账单周期，再决定是否需要继续降频或升级套餐。
