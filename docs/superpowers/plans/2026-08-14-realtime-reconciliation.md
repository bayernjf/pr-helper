# 实时校准链路修复计划（2026-08-14）

## 一、问题

推提交后自动创建 PR 不发生，最坏要等数小时。用户判定为严重缺陷：临时手动派发 cron 只能自救，交付给用户等于系统不可用。

## 二、生产证据

`bayernjf/pr-helper` stage 0（`feature/20260722 → dev`）在 2026-08-14 10:03 推送 18 个提交后，`workflow_stage_states.ahead_by` 仍为 0、`updated_at` 停在 08:51、`last_event` 为 null，`workflow_automation_actions` 无任何行。前置条件全部满足：`automation.executionMode='server'`、`triggerMinCommits=1`、规则快照非空、AI 凭据两个开关均为 true、GitHub 侧 `ahead_by=18`、上一个 PR #193 已合并且门禁全绿。

| 编号 | 根因 | 证据 |
| --- | --- | --- |
| RC1 | webhook 校准不可靠地被截断 | `reconciliation_runs` 中 666/669/671/675/676/677/678/679/680 共 9 条 `trigger='webhook'` 停在 `state='running'`、`stages_total=0`、`finished_at` 为空 |
| RC2 | 截断是随机的，不是稳定失败 | 674 号 webhook 行活了 238 秒才死，死因是 `GitHub 请求超时`（`stages_total=2 / failed=2`）。实例还热就继续跑、被回收就当场消失 |
| RC3 | 一次 push 放出 5 条投递、各自触发一次全量 sweep | 10:03:37–10:03:41 依次收到 `push`、`check_suite`、`status`、`check_run`×2，对应 675–679 五条并发；`query()` 是 `max: 1` 连接池 |
| RC4 | 失败在界面上不可见 | `listSyncHealth` 排序为 `ORDER BY finished_at DESC NULLS LAST`，未收尾的行排在最后，面板永远显示最近一次成功的 cron；`stages_total` 只在收尾 UPDATE 才写，被截断的行连意图都留不下 |
| RC5 | cron 兜底的轮转被队首工作流永久占用 | `soft-desk`、`bayjf` 停在 06:04 且连续四轮未前进，而每轮实际产出（17/10/10/10 个 stage）恰好对应「10 个名额里有 2 个产出 0 任务」。`routeSourcesForStage` 对匹配不到分支的动态 source 规则返回 `[]`，该工作流不写任何行 → `max(updated_at)` 不前进 → 下一轮仍排队首。剩 8 个名额轮 32 个工作流、cron 实际间隔 60–70 分钟 → 全量轮转约 4–5 小时 |

`push` 事件本身订阅正常（10:03:37 有投递），`docs/current-state.md:110` 记录的订阅列表已过时，需一并修正。

## 三、修复方案

### 1. 按事件分支收窄校准范围

`reconcileWorkflowStages` 的 filter 增加 `branch?: string`。新增纯函数 `webhookBranchesForEvent(eventName, payload)`：`push` 取 `ref` 去掉 `refs/heads/`；`pull_request` 取 head 与 base；`check_run` / `check_suite` / `workflow_run` 取 `head_branch`；`status` 取 `branches[].name`。命中的分支为空则不做任何 GitHub 调用直接返回。

`reconcileWorkflowScope` 在展开任务后按分支过滤：保留 `stage.target === branch` 或解析出的 source === branch 的任务。静态 source 直接比较，动态规则仍需 `routeSourcesForStage` 解析后再过滤。

效果：一次 push 的工作量从「34 个工作流全量」降到「命中的 1–2 个 stage」，约 6 次 GitHub 调用、1–3 秒。

### 2. 保证这份被收窄的工作跑完

webhook 处理器改为在返回 202 **之前** await 这份被收窄的校准，并加约 8 秒时间预算（Hobby 计划函数上限 10 秒）。超预算立即返回 202 并把剩余部分交给 cron。不引入新依赖，不依赖平台的后台执行语义。

`api/[action].ts` 的收件箱刷新同样改为收窄范围后 await，否则「点一次刷新」仍然不可靠。

### 3. 同仓库同一时刻只允许一条 sweep

用 `pg_try_advisory_lock(hashtext(user_id || ':' || repository))` 包住 `reconcileWorkflowScope`。拿不到锁就跳过并在 `reconciliation_runs` 记一条 `skipped`，而不是排队等待——`max: 1` 连接池下排队等于自锁。一次 push 的 5 条投递里第一条做完整工作，其余四条直接 no-op 返回。

### 4. 让失败可见

- `stages_total` 在进入 per-stage 循环之前先写，被截断的行也能留下意图。
- cron 里加收尾清理：`started_at` 早于 5 分钟且仍为 `running` 的行标为 `failure`，原因写「运行被中断」。新增纯函数 `reconciliationRunIsAbandoned(startedAt, now)` 承载判定。
- `listSyncHealth` 改为按 trigger 各返回最近一条，并附最近 24 小时被中断的条数，webhook 链路死掉时面板必须变色。

### 5. 修 cron 轮转的队首占用

新增有序迁移 `027`，给 `pr_helper_workflows` 加 `last_reconcile_attempt_at`。选批改为按「尝试时间」而非「状态写入时间」排序，`reconcileWorkflowScope` 无论是否产出任务都更新该列。产出 0 任务的工作流因此让出名额，32 个工作流的全量轮转回到 1 轮以内。

### 6. 文档

修正 `docs/current-state.md:110` 的订阅列表，并把本节证据链与修复后行为写入 `docs/current-state.md`、`docs/auto-create-pr-remediation.md`（第八节该条从「不在本批」移出）、`handoff.md`。

## 四、测试

按仓库约定先写失败测试再实现，只测纯函数，不 mock SQL：

- `webhookBranchesForEvent`：六类事件各一例、缺字段、tag push（`refs/tags/...` 不参与）。
- 分支过滤：静态 source 命中 target、命中 source、都不命中返回空。
- `reconciliationRunIsAbandoned`：边界与已收尾行不受影响。
- `selectReconciliationBatch`：产出 0 任务的工作流在下一轮让出名额。

E2E 不覆盖（服务端链路，无浏览器可观测面）。`npx tsc --noEmit` 与 `npm run lint` 必须干净。

## 五、部署与验收

本机无法访问 `*.vercel.app`（DNS 污染），验收走 GitHub Actions、`gh api` 或用户浏览器与 SQL：

1. 推一个提交到已勾选自动创建的分支，`reconciliation_runs` 应出现 `trigger='webhook'`、`finished_at` 非空、`stages_total>0` 的行，PR 在数秒内出现。
2. 同一次 push 的其余 4 条投递应产生 `skipped` 行而不是并发 sweep。
3. 无关分支的 push 应只记投递、不产生 sweep。
4. 24 小时后 `reconciliation_runs` 不应再有滞留 `running` 行。
5. 全量轮转在一轮 cron 内覆盖 32 个工作流。

## 六、风险与回滚

纯代码改动加一条新增列的迁移，回滚等价于回退提交；迁移是additive，不需要回退 DDL。`CRON_RECONCILE_BATCH_SIZE=0` 仍可在不发版的情况下关闭分批。

时间预算方案的已知代价：极端情况下 webhook 仍可能来不及做完，此时退化为 cron 兜底——但修复 RC5 后兜底周期从 4–5 小时回到一轮。

## 七、不在本批

自动合并的生产验收（代码已在本地落地待部署）、合并后自动推进、泳道徽标与 `workflowRunSummary` 当前步指针、`P4`/`P5`/`P6` 三项未落代码的既有问题。
