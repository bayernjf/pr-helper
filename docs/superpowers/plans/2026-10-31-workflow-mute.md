# 流程静音（mute）设计 —— 待批准

> 日期：2026-10-31。状态：**设计稿，未实施**。批准后按第八节拆分实施。
> 前提修正：本方案最初以「归档/静音中间态缺失」立项，调研发现**归档已于 2026-08-17 实现并完成生产验收**（[`handoff.md`](../../../handoff.md)《2026-08-17 流程归档》，`archived` 列自迁移 `036` 起，cron/webhook/manual/inbox_refresh 四路全排除，UI 与恢复链路齐备）。真正缺的只有**静音**——本方案因此只设计静音。同时回填 `current-state.md` 第八节与 remediation P7 里写于归档实现之前的过时表述。

## 一、静音要解决什么

归档的语义是「彻底退出校准范围」，适合沙盒、已下线、不再维护的流程。但有一类流程**仍在活跃维护**：对账、投影、自动化都该照常跑，只是不想被 Web Push 一直打扰（高频仓库的 checks 成败、new-pr-ready、merge-ready 通知）。静音就是这个中间态：**流程照常活着，通知闭嘴**。

P7 的原始场景（沙盒路由常驻待办）不属于静音：那是「退出校准」的诉求，用归档即可，不需要新代码。沙盒 4 流程的处理建议也已从「删除」改为「先归档看 sweep 收益（~29s → ~15s），满意后要不要删再定」——归档可逆，删除不可逆。

## 二、v1 语义边界

**muted 流程 = 除了不推送，其它一切照常**：

| 维度 | 归档（已上线） | 静音（本方案） |
| --- | --- | --- |
| cron 校准 | 退出 | 照常 |
| Webhook 投影 | 停写 | 照常 |
| 自动化入队/执行 | 取消 queued/paused、停止入队 | 照常 |
| Web Push | 天然无（不在校准范围） | **不发送** |
| 看板/失败中心/计数 | 收进归档视图 | 照常（lane 加静音徽标） |
| 审计 | `workflow-updated` + `metadata.archived` | 同构：`metadata.muted` |
| 可逆性 | 恢复后置 `reconcile_pending_since` 补校准 | 取消静音后下一事件即恢复推送 |

明确**不做**的（v1 非目标）：

- **不静看板/失败中心**：静掉失败可见性会制造「看不见的失败」，与规则「绝不绕过 GitHub 拒绝在 UI 状态」的精神冲突。静音只针对主动打扰（推送），不针对按需查看的信息。
- **不做按事件类型细分静音**（只静 checks / 只静部署）：5 个触发点、1 个布尔位足够覆盖真实诉求；细分属于 YAGNI，等有真实场景再立项。
- **不做定时静音**（`muted_until`）：同上。
- **不做批量/自动静音**：与归档当时「本版不做批量与自动归档」同一纪律。
- **不补发**：静音期间错过的事件不补发。推送是即时性产品，静音是明确的「别吵我」，补发反而制造噪音洪峰。取消静音后从下一个事件起正常推送。

## 三、存储：迁移 `045_mute_column.sql`

```sql
ALTER TABLE pr_helper_workflows
  ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false;
```

- 与 `archived` 完全同型（`036:28`）。**不需要部分索引**：`muted` 不出现在任何 WHERE/JOIN 里，读取只发生在 sweep 已取回的工作流行上（`trackedWorkflowColumns()` 列清单加一项，零额外查询）。
- domain 侧沿用 `archived` 的既有约定：`Workflow.muted?: true`（`?: true` 而非 boolean，恢复**删键**，避免 `muted: false` 噪音沉进审计 metadata）；纯函数 `muteWorkflow` / `unmuteWorkflow` / `mutedWorkflows` 落在 [`src/lib/workflow.ts`](../../../src/lib/workflow.ts) 现有 `archiveWorkflow` / `restoreWorkflow` / `archivedWorkflows` 旁边。
- 持久化走现有保存通道：`workflowToRows` / upsert 列清单加 `muted`，版本号照常 +1，审计照常记 `workflow-updated`（metadata 带 `muted`，与归档的 `metadata.archived` 同构）。`workflow_versions.snapshot` 已停止新写入（`040`），不涉及快照。

## 四、服务端过滤点：5 个推送触发处

推送触发全部集中在 `reconcileStageWork` 内的 5 处 `phase('notify', () => sendPushNotifications(...))`（[`api/_lib/workflows-store.ts`](../../../api/_lib/workflows-store.ts) :2167 部署成败、:2287 new-pr-ready（无 PR）、:2329 checks 成败、:2334 merge-ready、:2338 new-pr（合并后新提交）），且 `workflow` 对象都在作用域内。

实现取**调用点判定**而非改 `sendPushNotifications` 签名：加一个本地小包装（`muted === true` 时直接跳过，连 `pr_helper_notification_deliveries` 的幂等行都不写），5 处统一走它。这样 `push.ts` 的职责不变（按 eventKey 幂等发推），静音语义完全留在 reconcile 侧。

静音期间**校准照常**意味着 stage 状态照刷、`reconciliation_runs` 照记、动作照常入队执行——这些是静音与归档的本质区别，也是验收重点。

## 五、UI

- lane 头部 `lane-actions`：未归档流程在「归档」旁加「静音/取消静音」（`data-mute-project`），复用归档按钮的渲染与持久化模式（`persistWorkflowArchive` 同款：本地保存 → 云端保存队列 → `loadActionQueue(true, repo)`）。
- muted lane 加静音徽标（复用 `lane-archived-badge` 的样式模式），看板计数**不变**（静音不减计数——它不是退出，只是安静）。
- 权限沿用 `workflow-edit`（与归档一致：可逆的流程级开关）。
- **无确认弹窗**：归档有确认是因为它取消在途动作；静音零副作用、随时可逆，与归档的「恢复」一样不做确认。文案落在 `zh.ts` 归档文案旁。

## 六、与团队共享的关系（明确决定）

`muted` 是**流程行上的全局状态，不是 per-user 偏好**：属主静音后，对该流程的所有共享可见者生效。理由：校准与通知本来就都算在属主头上（sweep 按 `row.user_id` 分组、推送发给属主的订阅），「属主让属主的通知安静」天经地义；per-viewer 通知偏好需要 per-user 表，与现有团队权限模型正交，留待真实需求出现。这与归档「共享流程的校准/通知算属主」的既有事实同构。

## 七、验收清单

1. **静音后**：muted 流程触发 checks/部署/PR 事件 → `pr_helper_notification_deliveries` 零新行、浏览器零推送；`reconciliation_runs` 照常认领该流程（`claimed_workflow_ids` 含它）、stage 状态照刷；自动化动作照常入队与执行。
2. **取消静音**：下一个事件恢复推送（不补发静音期间的）。
3. **审计与版本**：静音/取消静音各产生一条 `workflow-updated`（metadata 带 `muted`），版本 +1。
4. **共享视角**：共享流程静音后，共享可见者不收到属主侧推送（推送本来就只发给属主）。
5. **测试**：domain 纯函数先写失败单测再实现（AGENTS 第 2 条）；推送过滤的服务端单测套 `workflows-store.test.ts` 现有纯函数/源码断言模式；迁移 `045` 落 `supabase/migrations/`，不在运行时执行 DDL。

## 八、实施拆分

改动面小（一列 + 5 处判定 + 一个按钮 + 文案 + 迁移），建议**单 PR 一次闭环**，避免归档能力先就位却无落地对象的空窗重演。迁移 `045` 在执行 `044` 之后按序跑。

## 九、待拍板的决策点

1. **v1 只静推送**是否覆盖你的真实诉求？若还想要「失败中心也不出现」，那是另一个带风险的语义，需要单独设计（静掉的失败谁来兜底）。
2. **全局静音**（对共享可见者生效）是否符合直觉？还是要 per-user？（推荐全局，理由见第六节）
3. **无确认弹窗**是否接受？（推荐接受，可逆零副作用）
4. 沙盒 4 流程改用**归档**还是维持**删除**？（推荐先归档量化 sweep 收益，满意后再决定删不删；删除仍需你点确认）
