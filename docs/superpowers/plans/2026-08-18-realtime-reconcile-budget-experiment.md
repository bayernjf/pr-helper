# 抬高交互式校准预算：一次可回退的环境变量实验（2026-08-18，已部署生效，观察中）

## 一、问题

`manual` 与 `inbox_refresh` 这两个交互式 trigger 的校准大多数跑不完。取 `reconciliation_runs` 里**已埋点 `github_calls`** 的全部运行（30 次）：

| 形态 | 次数 | 平均耗时 | 平均完成 / 总数 |
| --- | --- | --- | --- |
| degraded，`github_calls = 0` | 9 | 9.9–10.6s | 0 / 1.0–8.5 |
| degraded，有 stage 跑完但被切断 | 14 | 10.7s | 2.2 / 6.4 |
| success | 7 | 6.7–7.2s | 全部（1.7–2.0 个 stage） |

**degraded 占 23/30 = 77%**，是常态而非例外。

## 二、被推翻的两个诊断

记下来是因为这两条都很像真的，且都误导过一次判断。

1. **「`github_calls = 0` 说明抢租约失败、在空转」——错。** `budget.calls` 是在 `reconcileStageWork` 返回**之后**才累加的（`api/_lib/workflows-store.ts:1605-1609`），所以 `0` 只表示**没有任何 stage 跑完**，不表示没发起调用。抢不到租约的路径根本不等待：`:1743-1747` 立刻写一行 `skipped` 就返回，对应库里那些 `duration_ms ≈ 375` 的行。
2. **「degraded 很罕见，可以不管」——错。** 这个结论来自只看最近 24 小时的 3 次。放到全量就是 77%。

修正后的结论：**23 次 degraded 全部属于「预算不够」一类，不存在争抢类。** 旁证是三次相邻的同样负载——3793（21:07:47，1 stage，超时）、3794（21:08:04，1 stage，3 次调用，**4650ms 成功**）、3795（21:08:40，1 stage，超时）；加上成功组平均 6.7 秒对着 8 秒预算，本来就只差一线。

## 三、这次要改的东西

只改一个 production 环境变量，不动代码：

```
REALTIME_RECONCILE_BUDGET_MS = 25000
```

改完**必须重新部署一次 production 才生效**（env var 不热加载到已有部署）。回退就是删掉这个变量再部署一次。

`realtimeReconcileBudgetMs`（`:1883-1887`）是一刀切覆盖：`configured` 在 trigger 分支之前就 return，所以这个值对所有 realtime trigger 生效。**选 25000 而不是别的数，正是因为它等于 `WEBHOOK_RECONCILE_BUDGET_MS`，webhook 的实际预算不变**——换成 20000 就会把 webhook 从 25000 降下来，而那个值有来历（`:1863-1867` 记着 8 秒预算下三分之一的 delivery 中途放弃，导致已合并 PR 的投影 stale 十分钟）。cron 走 `cronReconcileBudgetMs`，不受影响。

### 已核对过的边界

- ceiling 变成 `min(25000+15000, 45000) = 40000`，仍在 `vercel.json` 的 `maxDuration: 60` 之内。
- 这个预算 / ceiling 组合 webhook 今天已经在跑，不是新领域。
- 租约 TTL 30 秒靠每 10 秒续期（`:1719-1721`），活着的 sweep 不会被后来者踢掉。
- `inbox_refresh` 的前端超时是 180 秒（`src/lib/action-queue-request-queue.ts:4`），不会提前掐断。
- `manual` 由「保存 workflow 且刚打开自动化开关」触发（`api/workflows.ts:87-88`），保存请求没有客户端超时。

### 代价

真正卡住的 stage 会把保存 / 刷新请求占住最多 25 秒（极端情况 40 秒），而不是 8 秒。这是本次实验换取信息所付的价钱，已知并接受。**上线后第一条样本就把这个极端值兑现了**：见下节。

## 三之二、变量已生效（2026-08-18 00:28 UTC 确认）

部署顺序：变量先建，随后 `vercel redeploy <生产 URL> --target production` 产出 `pr-helper-3x705oex3`（00:21 Ready）。命令记一笔纠正——`vercel redeploy` **没有** `--prod`，要「部署 URL + `--target production`」。

**判据样本 run 5368**（`inbox_refresh`，00:28:06）：`stages_total` 55，`stages_reconciled` **36**，`duration_ms` **39962**，169 次 GitHub 调用。

结论成立的原因是算术而非观感：旧配置的 ceiling 是 `min(8000+15000, 45000) = 23000`，一次运行不可能跑到 40 秒；39962 正压在新的 `min(25000+15000, 45000) = 40000` 上。对比同类旧样本 run 4987（15 个 stage、11.2 秒、**校准 0 个**）。

**顺带发现一件原先没看清的事，它可能比本实验的结论更重要：** 该账号 `workflow_stage_states` 总量就是 55 行，即一次全量刷新的规模远超任何请求预算装得下的量——40 秒只做完 65%，仍然 degraded。而且 `error_message` 是「校准未在预算内完成」（内层让出的措辞，不是外层上限那条），说明 25 秒阶段预算之外还花掉约 15 秒：那是 55 个 stage 的路由解析，它在阶段预算**之外**（`:1781-1788` 位于 `withStageDeadline` 之前）。

因此对全量刷新这种规模，**加预算追不上，第五节的方案 B（交互请求不再同步等 sweep）才是出口**。但一条样本不足以定调：若一周内绝大多数刷新是小规模（如 run 5363 的 1 个 stage、4.4 秒），25 秒就够用，全量刷新属少数情况。仍按第四节的占比口径判。

## 四、观察口径

一周后按同一条口径复查，避免事后换标准：

- **基线：有 `github_calls` 记录的 30 次 `manual` / `inbox_refresh` 运行里 23 次 degraded（77%）。**
- 复查用同一个过滤条件（`trigger IN ('inbox_refresh','manual') AND github_calls IS NOT NULL`），比较 degraded 占比，并分别看 `github_calls = 0` 与 `> 0` 两组的变化。

判读规则先定好：

- **占比明显下降** → 预算确实是瓶颈，接下来决定是留着这个 env var，还是给 `manual` / `inbox_refresh` 拆独立常量以便调到 25000 以外的值。
- **占比没动** → 卡的不是时间，而是某个 stage 本身会挂。那就**不要继续加预算**，转方案三。

## 五、备选方案

- **方案 A：给 `manual` / `inbox_refresh` 拆独立常量 + env var。** 未采用作为第一步。它与本方案效果几乎相同（因为 25000 恰好使 webhook 不变），唯一多出来的能力是「将来能把这两个 trigger 调到 25000 以外」，而在还不知道预算是否为真瓶颈之前，先付一条新配置面的代价不值得。如果第四节判读为「占比明显下降」，它就是自然的下一步。
- **方案 B：交互请求不再同步等 sweep**，直接返回并靠 cron / webhook 收敛，UI 用 sync health 显示进度。最干净，也是第四节判读为「占比没动」时的去处。未作为第一步是因为它改变产品行为，需要单独设计，而当前还缺一条判断它是否必要的证据。
- **方案 C：什么都不做。** 已否决。理由是曾以为 degraded 罕见，全量数据显示占 77%，且成功组耗时紧贴预算上限。
