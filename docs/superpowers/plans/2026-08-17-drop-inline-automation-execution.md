# 收敛自动化动作的执行入口：删掉 sweep 内联执行（2026-08-17，方案 B 已实施、已部署并验收）

对应 [`handoff.md`](../../../handoff.md) 后续事项第 6 项：「drain 稳定观察若干天后，删掉 sweep 内联的执行路径，让自动化动作只剩一条执行入口」。drain 自 2026-08-15 17:06 由 `pg_cron` 每 2 分钟驱动（迁移 030），已连续运行两天以上，包含 2026-08-17 13:55–15:45 那场 GitHub 上游故障，具备动手的前提。

本文只是方案。**尚未实施，也不建议在批准前实施**——删除本身很短，但它牵动 drain 的门禁退避规则，那部分不是可选项。

## 一、现状：一个执行器，两套准入策略

先纠正一个容易写错的说法：**不是「两套会各自漂移的实现」**。两条路径最终都调用同一个 `executeWorkflowAutomationActionForUser`（[`api/_lib/workflows-store.ts:521`](../../../api/_lib/workflows-store.ts)），执行器只有一份。真正分叉的是**动作被允许执行之前的那套判断**：

| | sweep 内联 | drain |
| --- | --- | --- |
| 入口 | `scheduleServerAutoCreate` `:220`、`scheduleServerAutoMerge` `:200` | `drainWorkflowAutomationActions` `:443` |
| 触发时机 | 入队的同一个请求内，同步 | `pg_cron` `*/2`，兜底 Actions `*/10` |
| 准入判断 | 仅 `automationInlineMergeShouldAttempt` `:283`（可重试的门禁等待才不打） | `automationDrainDecision` `:326` 全套 |
| 归档取消 | 无 | 有（`cancel/archived`） |
| 被后续提交取代（`hasNewer`） | 无 | 有（`cancel/superseded`） |
| 12 小时过期（`AUTOMATION_ACTION_STALE_MS`） | 无 | 有（`cancel/stale`） |
| 尝试次数上限 | 无 | 有 |
| 指数退避（`automationGateWaitDelayMs`） | 无 | 有 |
| 被回收实例的重新认领（`ABANDON_MS`） | 无 | 有 |
| 函数预算保护（`DRAIN_START_BUDGET_MS`） | 无 | 有 |

所以问题不是「两份代码要同步改」，而是**内联路径绕过了全部限流与取消策略**。这不是理论风险：生产上 `merge-pr` 成功动作的 `attempts` 最大值是 **47**，被取消的最大值是 **26**（近 7 天，`workflow_automation_actions`）。handoff 第 10 项记的动作 205 重试 47 次、持续 75 分钟、每次约 6 次 GitHub 调用，就是内联路径没有退避的直接后果。2026-08-16 部署的 `automationInlineMergeShouldAttempt` 只堵住了「可重试的门禁等待」这一类，其余类型仍然直接打。

内联存在的理由只有一个：**时效**。它让「push → PR 建好」发生在同一次 webhook 投递内。近 7 天成功动作的 `created_at → updated_at`：

| kind | ≤15s | 15–150s | >150s | p50 | p90 |
| --- | --- | --- | --- | --- | --- |
| create-pr | 79 | 14 | 17 | 8.6s | 600s |
| merge-pr | 25 | 53 | 24 | 37.8s | 506s |

`create-pr` 有 79/110（72%）在 15 秒内结束——那批就是内联跑的。这是要付的代价，必须先摆明。

## 二、拦路的耦合：drain 的门禁退避是按「内联存在」写的

`automationDrainDecision` 里有两处注释把内联当作机制前提：

- `:300-302`（`AUTOMATION_GATE_WAIT_MAX_MS`）：「A gate-held action is not retried on a clock to make it succeed sooner — **the event that clears the gate runs it inline** — so this only bounds how late a missed event is recovered.」
- `:353-358`（queued + failure_reason 的 skip 分支）：「**The reconcile that the clearing event triggers runs the action inline**, so nothing arrives sooner for the drain having asked again in between.」

也就是说：一个等门禁的 `queued` 行带着 `failure_reason`，drain 会在 `automationGateWaitDelayMs(attempts)`（基数 300 秒，按 attempts 指数翻倍，上限 30 分钟）内**主动跳过**它，因为设计上认定「门禁一清，那次事件的 sweep 会内联把它跑掉」。

内联删掉之后，这个假设不成立了。好在 `scheduleServerAutoMerge:195-196` 有一处刻意的设计救了半条命——写 `failure_reason` 时**故意不碰 `updated_at`**，所以退避窗口不会被每次投递往前推。但仍然会退化：门禁在 reason 写下 30 秒后就清了，drain 却要等到 `updated_at + 300s` 才执行，白等约 4.5 分钟；attempts 到 4 时退避是 40 分钟、被上限压到 30 分钟。**合并延迟从秒级变成最长 30 分钟。**

所以删除必须配一处改动：**sweep 从「执行者」改成「信号源」**。重算 `automationMergeOutcome` 后

- 结论是 `merge`（或不再是可重试的等待）→ 清掉 `failure_reason` 并 `updated_at = now()`，让 drain 下一个 `*/2` tick 就执行；
- 结论仍是 `paused` → 写下 reason，保持不碰 `updated_at`（现状行为）。

改完之后指数退避只管「没有任何事件来清门禁」的情况，那才是它本来的意图；门禁一清的路径由「清 reason + 下一 tick」承接，延迟 ≤120 秒而不是 ≤30 分钟。这一段是方案的实质，删除只是它的附带结果。

## 三、具体改动

`api/_lib/workflows-store.ts`：

1. `scheduleServerAutoMerge` `:189-205`：删掉 `:200-204` 的 `try { executeWorkflowAutomationActionForUser } catch {…}`。`:193-199` 的分支改为对**所有** `paused` 结论写 reason（不再区分是否可重试），并新增第二节说的「结论转为可执行时清 reason 并 bump `updated_at`」分支。函数保留——它仍然负责入队与判决落库，`gate` 入参仍被 `automationMergeOutcome` 使用。
2. `scheduleServerAutoCreate` `:207-227`：删掉 `:220-226` 的 `try/catch`，函数在 `if (!actionId) return;` 后结束。`:211-217` 的 `not-creatable` 跳过行与缺失部署提示原样保留。
3. 删掉 `automationInlineMergeShouldAttempt` 及其注释 `:279-285`——去掉内联之后它没有调用方。
4. 重写 `:300-302` 与 `:353-358` 两处注释：门禁等待的承接机制已换人，注释若留着就是错的，而这两处注释正是当初定这两个常量的论证。
5. `executeWorkflowAutomationActionForUser` `:521` 本身不动，只剩 drain 与手工执行（[`api/workflows.ts:54`](../../../api/workflows.ts)）两个调用方。

不动的部分，逐条说明理由：

- **drain 的 `*/2` 不改成 `*/1`**。它是对齐 `AUTOMATION_ACTION_ABANDON_MS`（120 秒）选的，改了就得同时重新论证 abandon 窗口；而且这是迁移文件（`AGENTS.md` 第 7 条：不得改已应用的迁移，只能新增有序迁移）。真嫌慢时这是第一个可动的杠杆，但它是独立一批，不混进来。
- **不在 realtime sweep 末尾顺手调一次 `drainWorkflowAutomationActions`**。这个想法能同时保住单一准入策略和秒级延迟，但一次 cron sweep 已经可能吃掉 40 秒预算（`CRON_RECONCILE_BUDGET_MS`），再叠一个 25 秒起跑预算的 drain 会顶穿 60 秒天花板；要做就得区分 realtime / webhook / cron 三条路径各自的余量，那是另一份方案。
- **手工执行入口不动**。那是用户显式动作，`AGENTS.md` 第 5 条要求它保持显式。

## 四、测试

`AGENTS.md` 第 2 条要求先落失败测试。障碍是这三个函数目前**都没有覆盖测试**（codegraph 确认：`drainWorkflowAutomationActions`、`reconcileWorkflowStages`、`enqueueWorkflowAutomationAction` 均无 caller 侧测试），且 `scheduleServerAuto*` 未导出、依赖真实 SQL 与 GitHub，单测不可达。仓库对这类代码已有既成惯例——**source-text guard**（`readFileSync` 自身源码后切片断言，见 `workflows-store.test.ts:1497`、`:1560`、`:1601`）。沿用它：

1. **新增失败守卫**：切出 `scheduleServerAutoMerge` 与 `scheduleServerAutoCreate` 的函数体，断言**不含** `executeWorkflowAutomationActionForUser`。改动前必然失败。
2. **新增失败守卫**：切出 `scheduleServerAutoMerge` 体，断言含清 reason 与 `updated_at = now()` 的那条 UPDATE——即第二节的信号源改动确实在位。
3. **纯函数单测**：`automationDrainDecision` 补一例——queued + failure_reason + `updated_at` 刚被 bump（reason 已清）时返回 `execute` 而不是 `skip`。这是延迟不退化的判据，且是可真单测的那一半。
4. **删除**：`automationInlineMergeShouldAttempt` 的 6 条断言（`:992-1006`）随函数一起删。
5. **确认不受影响**：`:1508` 的 `not-creatable` 守卫与 `:1601` 的 `missingDeployments` 守卫都只断言跳过行，删 `try/catch` 不影响，跑一遍确认而不是假定。

全量门槛照旧：`npm test`（当前 488 通过 / 27 文件）与 `npx tsc --noEmit`。

## 五、生产验收（2026-08-17 23:39 UTC 部署，已通过）

沙箱阶段在 `bayernjf/pr-helper-e2e-sandbox` 的 `E2E Failure and Dynamic Rule` 流程做（既有约定）。按 B 的范围只看三件事，第 4 项作废，理由见下。

1. **create 延迟不变**（B 保留内联创建，这一项是「确认没被误删」而不是「确认回归可接受」）。**通过**：push `fix/inline-removal-acceptance` → 动作 247 `create-pr` **7.4 秒**成功、`attempts = 1`，与部署前 p50 8.6 秒同一量级。
2. **门禁清除后的合并延迟 ≤120 秒**。**通过，且是这批改动的关键判据**。对象是动作 239（PR #15，`fix/archive-while-archived → dev`，`attempts = 16`、`failure_reason = 'PR 还需要 1 个 Approval'`、`updated_at = 23:28:04`）。`automationGateWaitDelayMs(16)` 已撞 30 分钟上限，即 drain 本会跳过它到 **23:58:04**。实测：Approval 于 **23:46:47** 给出 → 23:47:08（21 秒后）webhook 那次 sweep 把 `failure_reason` 清空并把 `updated_at` 推到当刻 → **23:48:07 合并成功**（GitHub 侧 `mergedAt = 23:48:06`），距 Approval **80.2 秒**，`attempts` 16 → 17。没有第二节的信号源改动，同一个动作要等到 23:58:04，即慢约 11 分钟——这 11 分钟就是「删内联」若不配套改造会付出的代价，这里被量到了。
3. **attempts 收敛**。**通过**。部署后新建动作 `max(attempts) = 1`。更直接的证据是动作 248（`fix/inline-removal-acceptance → dev`，同样卡在缺 1 个 Approval）：它入队后有 **4 次成功 sweep** 触达该仓，而它的 `attempts` 始终是 **0**，`updated_at` 一次未被推后。部署前这 4 次每次都是一轮内联合并尝试，每轮一次完整门禁重读（约 6 次 GitHub 调用）且 `attempts` 逐次加一——这正是历史峰值 47 的生成机制，现已归零。
4. ~~**`失败字符串归零`**~~。**作废，判据本身错了**：`failure_reason` 在动作成功时被写成 `NULL`，「自动合并 PR 失败」这类瞬时原因不会在成功行上留存。部署前查一次即证：全表该字符串计数已经是 0。要证明内联合并没了应看第 3 项的 `attempts` 与 `updated_at`，或直接看 `origin/main` 的源码（`scheduleServerAutoMerge` 内不再出现 `executeWorkflowAutomationActionForUser`），不能靠这个计数。

生产侧不做额外动作：未触发回滚，未改生产合并行为。沙箱 PR #15 已合入沙箱 `dev`（Approval 由用户授权后经 `gh` 代提，记在 bayernjf 名下），PR #16 与动作 248 留作后续门禁场景的现成样本。


## 六、备选方案

摆出来是因为「删代码」不必然是最优解，这三条都是可选项。**结论：推进 B。**

- **B. 只删内联合并，保留内联创建（采纳）**。合并不可逆且依赖门禁，漂移代价高；创建无门禁、`automationCreateOutcome` 本身幂等（已有开着的 PR 即返回 `idempotent`），重复入队最坏是一次多余的 GitHub 读。收益：47 / 26 两个重试峰值全部来自 merge，B 就把它们清了，同时保住 72% 的秒级创建体验。代价：第 6 项只完成一半，`handoff.md` 不能写成「已收敛为单一入口」，且以后每加一条 drain 规则仍要判断创建路径要不要跟。
- **A. 全删 + 信号源改造（不采纳）**。不是因为它错，是因为收益已被 B 拿走。**A 和 B 的难点是同一个**：第二节那处耦合本质是关于合并的——`automationGateWaitDelayMs` 等的是 checks / approval / mergeability，只有 merge 会进那个状态，所以 B 一样要做信号源改造，一分工都没省。A 多付的是创建侧 72% 动作从 8.6 秒变成约 65 秒，多换来的是把 drain 那套规则套到创建上；而 `create-pr` 近 7 天 `max(attempts)` 是 3（成功）/ 1（取消），退避、attempts 上限、`hasNewer` 取代**在创建侧实测没有拦下过任何东西**。用常态延迟换一组从未生效的保护，不划算。A 的结构整洁本身是真收益，但删掉内联合并之后剩下的内联面只有一个无门禁、幂等的创建动作，那份「每加规则都要论证内联」的税小到不值得用延迟去换。
- **C. 什么都不做（不采纳）**。它的论证有一半对：造成 47 次重试的那一类确实已被 `automationInlineMergeShouldAttempt`（2026-08-16 已部署）堵住。但那只堵了「可重试的门禁等待」。内联合并仍然在**不可逆操作**上绕过 `hasNewer` 取代取消——一个旧 head sha 的合并动作，在更新提交已入队之后，内联路径照样会打，可能合并掉一个已被取代的判决。这不是延迟或调用量问题；它近 7 天没造成损失，但这是合并，一次就够。C 成立的前提是「剩余风险不可逆性低」，此处不成立。

B 的实施范围：第三节的第 1、3、4、5 条照做（内联合并删除、`automationInlineMergeShouldAttempt` 删除、两处注释重写、执行器不动），**第 2 条不做**——`scheduleServerAutoCreate` 的 `try/catch` 保留。第五节验收去掉第 1 项（创建延迟不变），其余三项照旧；第 4 项只应看到「自动合并 PR 失败」归零，「自动创建 PR 失败」仍会出现。
