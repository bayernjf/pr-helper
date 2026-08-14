# 勾选即生效的对称化与勾选时确认（2026-08-14，本地已落地待部署验收）

前一批（连接池放开、勾选自动创建后立即校准）见 [`2026-08-14-reconciliation-lease.md`](2026-08-14-reconciliation-lease.md) 与 `docs/auto-create-pr-remediation.md` 第十二节。本计划处理那一批留下的两个问题：自动合并的触发时机与自动创建不对称，以及「勾选即刻执行」没有任何确认。

## 一、问题

三种情形下勾选的真实后果不一致，且用户无从预判：

| 情形 | 目前的行为 | 问题 |
| --- | --- | --- |
| 新提交还没来就勾选 | 落库，等下一次 webhook 才动作 | 正常，反选有充足时间 |
| 已有新提交后才勾选自动创建 | 保存那一次 HTTP 往返内就把 PR 建出来 | 勾选等于点了「创建」，零犹豫时间，且界面没有任何提示 |
| 已有开着的 PR 后才勾选自动合并 | 不触发，要等下一次真实 GitHub 事件 | 生产定时校准间隔 50–100 分钟，用户看到的是「勾了但什么都没发生」 |
| 勾选后新提交在几秒内到达 | 执行器认领动作后重读 payload，反选若已落库则抛「策略已失效」 | 行为正确，但从未写明这是尽力而为而非取消保证 |

第十二节把自动合并排除在立即触发之外，理由是「保存一个勾选不等于授权合并生产（`AGENTS.md` 第 5 条）」。这个论证站不住：自动合并作用于**已经创建好的 PR**，推迟到下一次 webhook 并不减少任何后果，下一次事件一样会合并，只是把同一个动作延后到用户注意力已经离开的时刻。延迟不产生安全性。

真正缺的不是延迟，是**明示**。`AGENTS.md` 第 5 条要求生产合并是「explicit user action」——一个写明 PR 编号与目标分支的确认对话框就是明示动作；而没有确认的静默立即合并才是违反。所以对称化（A）与勾选时确认（B）必须同批落地，只落 A 会把爆炸半径扩大到 `main`。

## 二、方案

### A. 服务端：activation 判定对称

`autoCreateActivated` 泛化为 `serverAutomationActivated(previous, next): { create: boolean; merge: boolean }`，仍按 `stageId` 比对保存前后（步骤可能被重排，按下标比对会错位），仍只认 `executionMode === 'server'`，仍只算 undefined/false → true 的方向。

`upsertWorkflow` 的返回从 `autoCreateActivated: boolean` 改为 `automationActivated: { create: boolean; merge: boolean }`；`create || merge` 为真时打 `reconcile_pending_since` 并触发一次 `reconcileRealtime(..., eventName: 'automation_enabled')`。校准本身不需要区分两者——sweep 会把该仓的自动创建与自动合并一并推进，区分只用于决定「要不要触发」和给出可读的日志。

### B. 客户端：只在真会立即发生时弹确认

判定放进 `src/lib/workflow.ts`（领域源真理之一，纯函数、可单测、不碰 DOM）：

```ts
export type ImmediateAutomationEffect =
  | { kind: 'none' }
  | { kind: 'create-pr'; source: string; target: string; aheadBy: number }
  | { kind: 'merge-pr'; source: string; target: string; pullNumber: number };
```

- 勾选自动创建：步骤已解锁、当前没有开着的 PR、`aheadBy >= triggerMinCommits` → `create-pr`；否则 `none`。
- 勾选自动合并：当前有开着的 PR → `merge-pr`；否则 `none`。
- 反选一律 `none`。

**不在 UI 预判门禁**（`AGENTS.md` 第 4 条：GitHub 是 checks、审批、mergeability 的权威，UI 不复制这套逻辑）。因此合并文案写「将立即尝试合并，门禁未通过则自动暂停」，而不是断言会合并成功。

详情页两个 change handler：effect 为 `none` 时行为不变，直接 `save()`；否则先弹确认，取消就把 checkbox 复位且不保存。复用现有 `confirm-dialog` 结构（`confirmAutoCreateExecution` 已是同一形态）。

### C. 竞态窗口：写进文档，不加机制

两条执行路径在认领动作后都重读了工作流 payload：`executeWorkflowAutomationActionForUser`（创建，`流程步骤自动创建策略已失效`）与 `runAutomationMergeAction`（合并，`流程步骤自动合并策略已失效`）。因此在动作被认领之前落库的反选会被尊重，动作记为失败而不是执行。

但入队与执行在同一个请求里同步完成，`queued` 状态几乎不停留，窗口约等于 push 到 webhook 投递的 1–3 秒。据此明确两点，不再加机制：

- 反选是**尽力而为**，不是取消保证。用户不应被引导去「抢在 webhook 之前反选」。
- 不为此新增撤销队列或「勾选后 N 秒宽限期」。队列本就不停留，没有可取消的对象；宽限期会让每一次正常触发都变慢，代价落在常态而收益只在误点。误点的防线是 B 的确认对话框。

## 三、测试（按仓库惯例：先落失败测试）

- `api/_lib/workflows-store.test.ts`：`serverAutomationActivated` 矩阵——仅 create 开、仅 merge 开、两者同时开、已开着再保存不算、`browser-session` 不算、开→关不算、步骤重排后按 `stageId` 正确匹配。
- `api/_lib/workflows-store.test.ts` 源码守卫：PUT 路径在 merge activation 时也会触发校准（沿用现有 source-text guard 风格，不 mock SQL）。
- `src/lib/workflow.test.ts`：`immediateAutomationEffect` 各分支，含 `aheadBy < triggerMinCommits` 返回 `none`、已有开着的 PR 时勾选自动创建返回 `none`、反选返回 `none`。
- e2e：勾选自动合并时出现确认对话框；取消后 checkbox 回到未勾选且未发出保存请求。

## 四、影响与风险

新增行为：勾选自动合并后不再需要等下一次 GitHub 事件；勾选任一开关若会立即产生动作，必先经过一次写明分支与 PR 编号的确认。

风险与缓解：

- **立即合并的目标可能是 `main`。** 确认文案必须同时写出 PR 编号与目标分支，让用户看见爆炸半径；服务端 `automationMergeOutcome` 仍是最终把关，门禁未过只会 `paused`。
- **effect 判定基于前端最近一次 statuses，可能已过期。** 最坏情况是弹了一个不准确的确认（该发生的没发生，或本以为不会发生的被服务端门禁拦下），不会产生未经确认的动作——确认是必要条件，不是充分条件。
- **迁移**：无。本批不动 schema。

## 五、不在本批

- 门禁状态在 UI 侧的预判或缓存。
- 撤销队列、勾选宽限期。
- `deploy` 阶段对稳定已合并路由的跳过优化——仍待连接池放开后复量再决定。

## 六、落地记录

实际落地与设计一致，无偏差。`immediateAutomationEffect` 放在 `src/lib/workflow.ts`，参数为对象形式（`toggle` / `enabling` / `stage` / `status` / `unlocked` / `triggerMinCommits`）；详情页两个 change handler 经 `confirmImmediateAutomation` 过一道，`none` 时行为与从前完全一致。顺带把 `confirmAutoCreateExecution` 抽到共用的 `confirmDialog`，两处确认框走同一实现。e2e 的 GitHub mock 新增 `openPull` / `compareAheadBy` 两个 fixture 字段，未设置时行为不变，因此既有用例不受影响。

## 七、提交拆分

1. `test:` 对称 activation 与 `immediateAutomationEffect` 的失败测试
2. `feat(store):` activation 判定覆盖自动合并
3. `feat(api):` 任一 activation 都触发校准
4. `feat(i18n):` 勾选确认文案
5. `feat(detail):` 会立即生效的勾选先确认
6. `test(e2e):` 覆盖勾选确认与取消
7. `docs:` 同步 `auto-create-pr-remediation.md`、`current-state.md`、`handoff.md`
