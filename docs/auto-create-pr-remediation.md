# 自动创建 PR 失效：诉求、问题与修复方案

> 创建：2026-08-14。
> 状态：`P1`–`P9` 已全部落代码并部署生产。**服务端自动创建 PR 已在生产端到端跑通**：`2026-08-14 00:20:08` 自动建出 `bayernjf/bayjf#42`。验收项 1–4 通过；项 5 待浏览器确认；项 6、7 需另造场景才能验；`P7` 已查清，不是缺陷，等一个数据清理决定。
> 当前事实来源仍为 [`docs/current-state.md`](current-state.md)。本文只覆盖服务端自动创建 PR 链路，不改变自动合并/自动推进「默认关闭且本阶段不实现」的结论。
> 方案与验收标准的上游文档为 [`docs/automated-workflow-plan.md`](automated-workflow-plan.md)。

## 一、诉求

1. 步骤开启「自动创建 PR」后，由服务端在门禁允许的时刻自动创建 PR，无人值守，不依赖浏览器打开。
2. 一个路由**已合并之后又产生新提交**时，要能继续创建下一个 PR，这是自动化的主要场景而非边界情况。
3. 「有新提交、可以创建」这个状态要在动作队列（收件箱）和步骤抽屉里都能看到，人工兜底和自动执行看到的是同一个判断。
4. 自动动作的任何失败都必须留下可读原因，不允许静默失败或永久停在 `queued`。
5. 幂等：同一个 `source → target` 不能因为重复触发而创建多个 PR。
6. 合并后门禁为红时**不自动向下游推进**（本文第四节的决策）。

## 二、生产证据链

2026-08-13 在生产库执行了四组查询，结论如下。

| 观察 | 结果 | 推论 |
| --- | --- | --- |
| `workflow_automation_actions` 中的滞留动作 | 2 条 `state='queued'`、`attempts=0`、`failure_reason=null`，分别创建于 2026-08-12 13:20 和 2026-08-13 17:18 | 动作**入队成功**但从未被领取；`attempts` 只在领取的 UPDATE 里自增，`failure_reason` 只在领取后的 catch 里写入，两者同时为空说明失败发生在领取之前 |
| `reconciliation_runs` | cron 有大量 `success`，`51 stages / 51 reconciled / 0 failed`，耗时 155–163 秒；另有 cron/webhook 行停在 `state='running'`、`stages_total=0`、`finished_at=null` | cron 实际是**跑完的**，GitHub Actions 报红只是 `curl --max-time 30` 先放弃；`--retry 2` 又额外派生了重叠的全量 sweep。webhook 触发的行**全部**停在 running，无一例外 |
| merged 且有新提交的路由 | 仅 1 条：`bayernjf/pr-helper-e2e-sandbox-1785691296724-69q14`，stage_index 2，dev → main，merged / success / `ahead_by=2` | 该路由未开自动化，所以它不是本次故障的原因；但它证明「已合并 + 全绿 + 有新提交」在生产真实存在 |
| 自动化配置 | 服务端偏好 `auto_generate_pr_message=true`、`auto_confirm_pr_creation=true`；只有 `bayjf-1786066410383-cjtnq` 的 `feature/20260719` 和 `pr-helper-1785096146747-e87zs` 的 `feature/20260722` 是 `mode=server` + `auto_create=true`，规则快照长度 1004，阈值 1 | 前置条件齐备，配置不是原因；受影响面为 2 个步骤 |

## 三、问题清单

### P1 BIGSERIAL 身份被当成数字使用（已修，工作区）

- **现象**：动作入队后永远停在 `queued`，`attempts=0`，无失败原因。
- **根因**：`workflow_automation_actions.id` 是 `BIGSERIAL`，postgres.js 默认把 `int8` 返回为**字符串**。`enqueueServerAutoCreate` 直接返回该原始值，`scheduleServerAutoCreate` 的 `if (!actionId) return` 放行了真值 `"2"`，随后 `executeWorkflowAutomationActionForUser` 第一行 `Number.isInteger(actionId)` 判假并抛错——**在它自己的 try 之前**。
- **佐证**：仓库内 `enqueueWorkflowAutomationAction`、`listWorkflowAutomationActions` 早就防御性地写了 `Number(row.id)`；`api/workflows.ts` 的手动执行入口也做了 `Number(payload.actionId)` 强转，这正是「手动按钮能用、自动路径不动」的原因。
- **修法**：新增导出的 `automationActionId()` 归一化，包住 `enqueueServerAutoCreate` 的 4 个返回点。
- **位置**：`api/_lib/workflows-store.ts`。

### P2 空 catch 吞掉失败（已修，工作区）

- **现象**：P1 抛出的错误不留任何痕迹，队列看起来是空闲而不是阻塞。
- **根因**：`scheduleServerAutoCreate` 的 `catch { /* 注释 */ }` 完全静默。注释假设「动作已被置为 paused 并带用户可见原因」，但当失败发生在领取之前时这个假设不成立。
- **修法**：catch 中写入 `failure_reason`，条件限定 `AND state = 'queued'`，避免覆盖执行器自己写的 paused 原因。
- **位置**：`api/_lib/workflows-store.ts`。

### P3 cron 全量 sweep 与客户端超时不匹配（已修，工作区）

- **现象**：GitHub Actions 的校准任务长期报红，同时库里出现 `stages_total=0` 的孤儿 running 行。
- **根因**：函数需要约 160 秒完成，`curl --max-time 30` 提前放弃并报错；`--retry 2` 在原次仍在执行时再发两次，形成重叠的全量 reconciliation。
- **修法**：按 `max(workflow_stage_states.updated_at)` 取最陈旧的 8 个 workflow 分批（仅 `trigger === 'cron'` 生效，webhook/inbox 作用域不截断），可用 `CRON_RECONCILE_BATCH_SIZE` 覆盖，`0` 关闭；`--max-time` 提到 90 秒并**移除 `--retry 2`**。
- **位置**：`api/_lib/workflows-store.ts`、`.github/workflows/reconcile-pr-helper.yml`。
- **代价**：全量轮转周期由 10 分钟变为约 60 分钟。这个代价成立的前提是 webhook 能承担实时性，而 webhook 目前被截断（见第八节），所以 P3 的最终定案依赖 webhook 修复。
- **生产验收通过**：上线前的定时运行以三次 `curl: (28)` 超时失败（旧的 `--max-time 30 --retry 2`）；上线后三次 `workflow_dispatch` 均成功，返回 `{"reconciled":8}`、`{"reconciled":8}`、`{"reconciled":15}`，耗时 21.5 / 21.5 / 36.5 秒，对比旧的 155–163 秒。
- **实测轮转周期远大于设计值**：GitHub 对 `*/10` 的 schedule 有节流，实际约**一小时**才落地一次(上线后 24 小时内只有一次 schedule 成功)。34 条流程按 8 条一轮需 4 轮，因此最坏反应延迟约 4 小时而非 1 小时。这不是分批逻辑的缺陷（分批排序经真实数据验证正确），但把 webhook 修复的优先级进一步抬高。
- **排查中曾两次误判分批引入回归，均已否证**：一是怀疑 `max(workflow_stage_states.updated_at)` 为 NULL 的流程被饿死——实际 NULL 折成 0 会排在**最前**，而新建的一批 landing 流程当时正是 NULL，它们连续占满了前几轮，看起来像是老流程被跳过；二是怀疑 payload 校验把流程剔出候选集、或 `JOIN pr_helper_users` 产生孤儿——生产 SQL 确认 34 行全部 JOIN 命中、payload 的 `automation` / `waitFor` / `independent` / `recoveryPolicy` 全为「键不存在」而非显式 `null`，两条都不成立。`bayjf-…cjtnq` 最终在 23:24:34 被正常校准。

### P4 `StageDecision.kind` 一个枚举承担两种语义（未落代码）

- **现象**：「已合并 + 门禁全绿 + 有新提交」永远不会被判为可创建。
- **根因**：`deriveStageDecision` 中 `merged && checks=success → 'merged'` 先于 `unlocked && merged && ahead_by > 0 → 'ready-to-create'` 命中。这不是分支写错顺序，而是两句话在同一时刻**都为真**，单个枚举只能表达一句，调换顺序只是换一边丢信息。
- **影响面**（四个消费点全部依赖 `kind === 'ready-to-create'`）：
  - 入队闸门：`scheduleServerAutoCreate` 直接 return，动作根本不入队。
  - 执行复查：入队窗口只存在于「已合并但门禁还没转绿」那一小段；一旦转绿，执行器复查翻成 `merged` 并抛「当前步骤尚未满足自动创建 PR 的门禁」，动作被置 paused。**这是一个自毁竞态**。
  - 动作队列：`listActionableStages` 显式过滤 `kind !== 'merged'`，「有新提交，可以创建新 PR」在收件箱永不出现。
  - 抽屉按钮：靠客户端 `canCreateFromDetail` 现拉 GitHub detail 兜住，所以人工能点——与 P1 同样的假象。
- **修法**：`StageDecision` 增加 `canCreateNext: boolean`，由 `unlocked && ahead_by > 0 && (pull_state === 'none' || pull_state === 'merged')` 推导；`kind` 语义不变。同时修正 `actionable`：`merged` 且 `canCreateNext` 时该路由确实有可执行操作，取值应为 `true`。
- **注**：`actionable` 全仓只有 `listActionableStages` 一处真正读取（前端仅在类型里声明、从不使用），因此修正它不产生连带影响。`src/lib/domain.ts` 已有语义相同的 `needsNewPullRequest(aheadBy, latestPullState)`，命名应保持一致。

### P5 「该分支已存在 PR」被当成失败（未落代码）

- **现象**：动作被置 paused，失败原因是 `该分支已存在 PR #N`。
- **根因**：动作的目标是「让 `source → target` 存在一个 PR」。目标已达成时抛错是判断错误——幂等操作遇到期望状态应记成功。
- **可达路径**：自动创建成功 → reconciliation 尚未把 `pull_state` 更新为 `open` → 分支又来新提交 → `headSha` 变化使幂等键不同 → 生成新动作 → 执行器发现 PR 已存在 → paused。修 P4 之后这条路径由不可达变为可达。
- **修法**：命中已存在的开放 PR 时走与成功一致的收尾（记录 `pullNumber`、置 `succeeded`、审计标记为幂等命中），不进 catch。

### P6 「没有可创建的新提交」被当成失败（未落代码）

- **现象**：动作被置 paused，失败原因是 `Source 分支没有可创建 PR 的新提交`。
- **根因**：入队依据是库里的 `ahead_by`，可能已过期；真正 compare 时新提交可能已被别的路径合走。此时动作是**已失去意义**，不是失败，不该要求人工接管。
- **修法**：置为终态（不占用待处理队列），与 paused 区分开。终态命名需与现有 `state` 约束一致，若需要新枚举值则按新增有序迁移处理，不得修改已应用的迁移。

### P7 沙盒路由会成为常驻待办（已查清：不是缺陷，属数据卫生）

- 第二节那条 e2e 沙盒 dev → main 现在就已经是 merged + 全绿 + `ahead_by=2`，只是被队列过滤掉才看不见。修 P4 后队列显示它是**正确行为**。
- **原以为的根因不成立**：`cleanupRetainedData` 只清 `RETENTION_DAYS` 里那 6 张历史/日志表（`github_webhook_deliveries`、`pr_helper_encrypted_sync_history`、`reconciliation_runs`、`workflow_stage_events`、`workflow_stage_deployment_runs`、`workflow_operation_audit_logs`）。流程定义 `pr_helper_workflows` 与其实时状态 `workflow_stage_states` 从来不在保留清理范围内，所以「沙盒 workflow 未被回收」并不是机制失效。
- **这个设计是对的**：流程定义是用户数据，按时间自动删除属于不可逆的破坏性操作，不应由后台任务代劳。唯一的删除入口是显式的 `removeWorkflow`（UI 的「删除整个流程」，二次确认 + 审计）。
- **删除不会留孤儿**：`workflow_stage_states`(004)、`workflow_stage_events`(008)、`workflow_versions` / `workflow_runs`(015)、`pr_helper_workflow_team_shares`(023)、`workflow_automation_runs` / `workflow_automation_actions`(025) 都以 `(user_id, workflow_id)` 外键 `ON DELETE CASCADE` 挂在 `pr_helper_workflows` 上，删流程即连带清空。
- **待你决定的动作**（二选一，都不需要改代码）：
  1. 在 UI 里删掉沙盒流程 `pr-helper-e2e-sandbox-1785691296724-69q14`，队列即恢复干净；验收报告里引用的 GitHub 仓库与 PR 不受影响。
  2. 保留它，接受收件箱长期多一条 `ready-to-create`。当前没有「归档 / 静音流程」的概念，若想保留又不想被提醒，那是一个新的产品需求，已记入 [`docs/current-state.md`](current-state.md) 的「八、非验收类后续开发」，后续单独设计开发。

### P8 执行器查询了不存在的列（未落代码，**自动创建从未成功的真正根因**）

- **现象**：动作停在 `state='queued'`、`attempts=0`，`failure_reason` 为 `column "stage_index" does not exist`。
- **根因**：`workflow_automation_actions` 表**没有** `stage_index` 列——`db/migrations/025_workflow_automation_queue.sql` 只把它建在 `workflow_automation_runs` 上，后续迁移也没有补。但有两条查询在 SELECT 它：
  - `executeWorkflowAutomationActionForUser` 的第一条语句。它在 `UPDATE ... state = 'running', attempts = attempts + 1` **之前**就抛错，所以动作既不被领取、`attempts` 也不自增，错误由 `scheduleServerAutoCreate` 的 catch（P2 修好的那个）写进 `failure_reason`。
  - `listWorkflowAutomationActions`，即 UI 的自动化队列面板，同样会 500。
- **为何一直没被发现**：`api/workflows.ts` 的手动执行入口调用的是另一条路径，不经过这条 SELECT；而在 P2 之前失败是完全静默的，队列看起来只是空闲。P1 修好身份归一化、P2 修好静默失败之后，这条错误才第一次被写进库里。
- **修法**：不加迁移，把这两条查询改为 JOIN `workflow_automation_runs` 取 `stage_index`。该列已存在于 runs 表，动作与 run 是多对一且必然有 run，JOIN 是最小改动。另一条路是加迁移在 actions 表冗余一列，但需要 NOT NULL 回填、且数据重复，代价更大。
- **测试形态**：这里无法 mock SQL，因此按 `AGENTS.md` 第 2 条先写一条**静态一致性守卫**：从 `db/migrations/` 解析出 `workflow_automation_actions` 的真实列集合，再从 `api/_lib/workflows-store.ts` 抽出所有针对该表的 SELECT 列名，断言前者包含后者。当前会因 `stage_index` 失败，修完转绿，此后任何「查了不存在的列」都会在 CI 被拦住。
- **位置**：`api/_lib/workflows-store.ts`。

### P9 AI 响应的 markdown 围栏未被剥离（已落代码，待部署验收）

- **现象**：`P8` 部署后动作 3 变为 `state='paused'`、`attempts=1`、`failure_reason` 为 `` Unexpected token '`', "```json\n{\n"... is not valid JSON ``（`updated_at = 2026-08-14 00:01:14`）。
- **根因**：`generateAutomationMessage` 原本写的是 `content.replace(/^```json\s*|\s*```$/g, '').trim()`——`trim()` 在 `replace()` **之后**执行，所以模型只要在围栏前多输出一个换行，`^` 锚点就匹配不上，围栏被原样送进 `JSON.parse`。收尾同理：围栏后带一个换行时 `\s*```$` 也匹配不上。
- **为何直到现在才暴露**：这条代码路径必须先通过 `P8` 才会被执行到，`P8` 之前执行器在第一条 SELECT 就抛错，从未走到 AI 解析。
- **修法**：抽出可单测的 `jsonFromModelText`，先 `trim()` 再判断是否以围栏开头；剥离开头那一行，并**从末尾**查找收尾围栏，这样 PR 正文里自带的代码块不会被误截。
- **不是永久卡死**：`paused` 超过 120 秒会被 `enqueueServerAutoCreate` 的 stale 重置逻辑放回 `queued`，所以每个轮转周期都会重试同一处失败，修完即可自愈，无需人工干预。
- **位置**：`api/_lib/workflows-store.ts`、`api/_lib/workflows-store.test.ts`。

## 四、需求决策

**`pull_state='merged'` + 合并后门禁失败 + `ahead_by > 0` 时，`canCreateNext = false`。**

理由：自动创建是无人值守动作。合并后 CI 已经是红的时候继续向下游创建 PR，会把问题带进下一段，出问题时更难定位。红灯应由人先看。

推论：门禁失败的路由在队列里仍然只呈现 `checks-failed` 一条待办，不会同时出现「可创建」，避免同一路由出现两条互相矛盾的提示。

## 五、修复方案

按 `AGENTS.md` 的要求，每步先写失败的单元测试，再实现最小通过改动。`deriveStageDecision`、`src/lib/domain.ts`、`src/lib/workflow.ts`、`src/lib/workflow-run.ts` 属于事实来源，改动前必须有测试钉住。

| 步骤 | 内容 | 涉及文件 | 状态 |
| --- | --- | --- | --- |
| 1 | `canCreateNext` 推导 + `actionable` 修正；`unlocked` 计算上移到函数顶部，使三处提前返回也能带上该字段 | `api/_lib/workflows-store.ts` | 已提交 `933dfd79` |
| 2 | 入队闸门与执行复查改判同一字段，消除 P4 的自毁竞态 | `api/_lib/workflows-store.ts` | 已提交 `933dfd79` |
| 3 | 动作队列入列条件与过滤条件改为显式判断，`merged` 且 `canCreateNext` 时以 `ready-to-create` 入列 | `api/_lib/workflows-store.ts` | 已提交 `933dfd79` |
| 4 | 抽屉创建按钮改读 `decision.canCreateNext`，不再依赖现拉的 GitHub detail | `src/main.ts` | 已提交 `fa2696e7` |
| 5 | 执行器幂等化：P5 记成功、P6 记终态 | `api/_lib/workflows-store.ts` | 已提交 `7a53c026` |
| 6 | 沙盒回收（P7）排查 | — | 已查清：非缺陷，见第三节 P7 |
| 7 | 执行器与队列列表改为 JOIN `workflow_automation_runs` 取 `stage_index`（P8），并加迁移列与 SELECT 的静态一致性守卫 | `api/_lib/workflows-store.ts`、`api/_lib/workflows-store.test.ts` | 已落代码，已部署生产并验证生效 |
| 8 | 抽出 `jsonFromModelText` 正确剥离 AI 响应的 markdown 围栏（P9） | `api/_lib/workflows-store.ts`、`api/_lib/workflows-store.test.ts` | 已落代码，待部署 |

步骤 5 的落地形态：新增纯函数 `automationCreateOutcome(openPulls, commitCount)` 作为可测接缝，`idempotent` 走与成功一致的收尾并在审计 `metadata` 打 `idempotent: true`；`cancelled` 写入 `workflow_automation_actions.state = 'cancelled'` 与 `workflow_automation_runs.state = 'cancelled'`，原因写在 `failure_reason`。两张表的 `CHECK` 约束在 `db/migrations/025` 中已包含 `cancelled`，因此**没有新增迁移**。命中已存在开放 PR 时不再请求 `compare`，少一次 GitHub 调用。

提交按功能拆分，`api` 与 CI 配置分开，commit message 用英文。

> 附带修复（与自动创建链路无关，独立提交）：`e2e/pr-helper.spec.ts` 的 9 个用例此前全红，有两个原因。一是 Playwright 用 Vite 默认端口 4173，而本机另一个项目的 preview 服务占着该端口，`reuseExistingServer: !CI` 直接复用了它，测试打在了别的站点上——端口已改为 4373。二是看板卡片改为默认折叠、编辑按钮标签由「编辑流程」改为「编辑」后用例未同步，现已改为先展开再点 `[data-lane-step]`。修复后 9/9 通过。

不需要 DDL：迁移基线保持 `001`–`026`，`019` 的 `workflow_stage_states_stage_identity_idx` 已覆盖 P3 新增子查询的前缀。若 P6 需要新的 `state` 枚举值，则新增有序迁移文件。

## 六、修复后的影响

### 新增行为

- 开启 server 模式自动创建的步骤，在「已合并 + 门禁全绿 + 有新提交」时会真的创建 PR。按第二节的配置查询，当前全库符合条件的只有 2 个步骤。
- 动作队列会出现「有新提交，可以创建新 PR」的待办，包括未开自动化的路由（人工兜底可见）。这与抽屉今天已经提供的能力一致，不引入新的产品语义。
- 幂等命中不再产生 paused，`已存在 PR` 与 `无新提交` 两类噪音消失。
- P1/P2 生效后，第二节那 2 条滞留动作会在下一次 reconciliation 被真实执行；若失败，会写入可读原因而不是继续静默。

### 不变

- `StageDecision.kind` 的取值和含义不变，`merged` 仍是终态。
- 泳道状态徽标不变：`src/lib/workflow-run.ts` 的 `stageRunPresentation` 是客户端独立逻辑，不经过 `deriveStageDecision`。**故意留在本批之外**——`workflowRunSummary` 用「第一个 tone 不是 succeeded 的步骤」作为当前步，改动它会让总览的当前步指针回跳到旧步骤，是可见的行为涟漪，需单独一批验证。
- 手动创建/合并 PR 路径不变。
- 自动合并、自动推进、生产合并与回滚仍不自动化。
- 前端类型 `decision?: { kind: string; actionable: boolean; message: string }` 中 `kind` 是宽松的 `string`，新增字段为纯增量，不破坏现有前端代码。

### 风险

- 队列条目数量会增加，收件箱徽标计数随之变化。
- P3 使全量轮转周期变长，在 webhook 截断问题修复前，自动创建的最坏反应延迟约为一个轮转周期。

## 七、回归测试

### 本地

- `npm test`：基线为 24 个文件 / 213 项（含本次工作区已加的 5 项分批 + 2 项身份归一化）。新增用例至少覆盖：
  - `canCreateNext`：`merged` + 全绿 + `ahead_by>0` → `true` 且 `kind` 仍为 `merged`；`ahead_by=0` → `false`；`pull_state='none'` + `ahead_by>0` → `true`；**门禁失败 → `false`**（第四节决策）；未解锁 → `false`；`stage_id` 不匹配 → `false`。
  - `actionable`：`merged` + `canCreateNext` → `true`。
  - 队列投影：`merged` + `canCreateNext` 产出一条 `ready-to-create`；门禁失败的路由只产出一条 `checks-failed`。
  - 既有 `deriveStageDecision` 断言必须零修改通过（现有用例使用 `toMatchObject`，加字段不会撞断言）。
- `npx tsc --noEmit -p tsconfig.json`（覆盖 `src` 与 `api`）、`npm run lint`、`git diff --check`。
- `npm run test:e2e`：确认抽屉创建按钮改判来源后，既有 API mock 场景不回归。

### 生产验收（本机无法完成，`*.vercel.app` 在本地被 DNS 污染，须走 GitHub Actions、SQL 或用户浏览器）

1. 校准任务在 GitHub Actions 转绿，且不再出现重叠运行。
2. `reconciliation_runs` 不再出现 `stages_total=0` 的孤儿 running 行（webhook 相关的除外，见第八节）。
3. 第二节那 2 条滞留动作变为 `succeeded` 并带 `pullNumber`，或 `paused` 且带可读 `failure_reason`——**不允许再停在 `queued` 且 `attempts=0`**。
4. 在 `feature/20260719` 推一个新提交，观察自动创建是否在一个轮转周期内触发，且只创建一个 PR。
5. 对已合并且有新提交的路由，确认收件箱出现待办、抽屉按钮可用，且两者判断一致。
6. 门禁为红的路由确认**没有**触发自动创建。
7. 幂等验证：连续两次触发同一 `source → target`，确认第二次记为成功幂等命中而非 paused。

**已执行结果（2026-08-13 至 08-14，`main` = `bc23f642`）**

| 项 | 结果 |
| --- | --- |
| 1 校准任务转绿、无重叠 | **通过**，见第三节 P3 |
| 2 无 `stages_total=0` 孤儿 running 行 | cron 一路 `success`；webhook 仍全部停在 running（本就在第八节例外内） |
| 3 滞留动作不再停在 `queued`+`attempts=0` | **通过**：P9 部署后动作 3 为 `succeeded` / `attempts=2` / `payload.pullNumber=42`（`updated_at = 2026-08-14 00:20:08`）。P8 部署后的中间态是 `paused` / `attempts=1`，执行器首次真正越过原子领取。原始记录（P8 之前）如下——**未通过，但暴露了 P8**：动作 3 拿到了可读原因 `column "stage_index" does not exist`（`updated_at = 23:24:37`），说明 P1/P2 生效、执行确实被触发，卡点在 P8。动作 1、2 的 `headSha` 已过期，不会再被执行 |
| 4 自动创建在一个轮转周期内触发且只建一个 PR | **通过**：P9 部署后第 3 轮 `workflow_dispatch` 建出 `bayernjf/bayjf#42`（`feature/20260719 → dev`，作者 `app/pr-helper-by-bayernjf`，`2026-08-14 00:20:08`），第 4、5 轮未重复建。`workflow_operation_audit_logs` 中 `metadata.via = 'workflow-automation'` 的记录只有一条（id 1347）。P8 部署后、P9 之前连跑 5 轮（reconciled 8/13/11/10/15）无 PR，卡点当时在 P9 |
| 5 收件箱与抽屉判断一致 | 待你在浏览器确认 |
| 6 门禁为红不触发自动创建 | 待验：现有生产数据里没有「合并后门禁为红且 `ahead_by > 0`」的步骤，需要另造场景 |
| 7 幂等命中记成功 | 未走到：第 4、5 轮之所以没重复建 PR，是因为动作已是 `succeeded`，`enqueueServerAutoCreate` 直接返回 null、根本没重新入队，比幂等分支更靠前就拦住了。要验 `automationCreateOutcome` 的 `idempotent` 分支需要另造场景（如手动先建同路由 PR 再入队）|

AI 生成的正文严格按生成规则模板输出（Overview / Changes / Related Issues / Test Info / Risk Notes），确认围栏剥离正确、规则快照生效。

链路上除 P8 之外的前置条件均已在生产核实：`pr_helper_ai_automation_credentials` 有一行且 `auto_generate_pr_message` / `auto_confirm_pr_creation` 均为 true；`bayjf-…cjtnq` 的 stage 0 为 `merged` / `checks=pending` / `ahead_by=3`、阈值 1、`executionMode='server'`，GitHub 侧确认 `ahead_by=3 behind=15 diverged` 且无开放 PR。也就是说 `canCreateNext` 与入队闸门都已放行，动作被真实领取执行，只是执行器第一条 SELECT 就抛错。

### 回滚方式

本批为纯代码改动、无 DDL，回滚等价于回退提交。P3 的批量大小可通过 `CRON_RECONCILE_BATCH_SIZE=0` 在不发版的情况下关闭分批。

## 八、不在本批

- **Webhook 与 inbox 的 fire-and-forget 截断**：`api/github/webhook.ts` 在返回 202 之后才 `void reconcileWorkflowStages(...)`，Vercel 随即冻结函数，因此每一条 `trigger='webhook'` 的 reconciliation 都停在 `running` / `stages_total=0`。全仓没有任何 `waitUntil`。这是 P3 代价成立的前提，也是自动创建实时性的关键，优先级应高于 P7。新增证据：2026-08-13 23:24 有一条 webhook 行以 `canceling statement due to statement timeout` 失败，`duration_ms=171876`，同时另有 6 条并发 webhook 行停在 running——`query()` 用 `max: 1` 连接池，被截断的 sweep 之间会互相挤压，所以修复形态需要同时考虑并发抑制，而不只是补 `waitUntil`。
- 泳道徽标与 `workflowRunSummary` 当前步指针（见第六节）。
- 自动合并、自动推进、无人值守代码修改。

## 九、遗留数据处置（已决定：都保留）

- `workflow_automation_actions` 的动作 1、2 仍停在 `queued` / `attempts=0`。它们的幂等键包含已过期的 `headSha`，既不会被 `enqueueServerAutoCreate` 复用，也不会被任何轮转执行，属于纯历史残留行。**决定保留**，作为这次排障的现场痕迹。`listWorkflowAutomationActions` 目前只有 `api/workflows.ts` 一个接口在用、前端无调用方，因此界面上不会显示这两行，不存在误导。若日后要清理，应先加「`headSha` 已失效则标 `cancelled`」的逻辑再跑，不手工 UPDATE 生产表。
- `P7` 的沙箱工作流 `pr-helper-e2e-sandbox-1785691296724-69q14`：**决定保留**。它唯一的成本是占一个 cron 轮转名额（每轮 8 个、共 34 个），不影响正确性；真要删就在界面上删，属于产品内的正常操作，不需要 SQL。
