# 校准租约与待校准接力修复计划（2026-08-14）

前一批修复（分支收窄、预算内 `await`、并发抑制、轮转公平）见 [`2026-08-14-realtime-reconciliation.md`](2026-08-14-realtime-reconciliation.md)。本计划处理那一批部署后由生产数据暴露出的三个残留缺陷。

## 一、生产证据

`reconciliation_runs` 三轮取数（13:00–13:20）给出的事实：

| 编号 | 缺陷 | 证据 |
| --- | --- | --- |
| RC1 | 会话级 advisory lock 在 Serverless 下不会释放 | 13:02:45 的 cron 行活了 8.7 分钟仍为 `running`，其间同仓所有 sweep 只能记 `skipped`。实例被冻结后永远不会执行自己的 unlock，锁随连接生死而非任务生死 |
| RC2 | 超预算的 sweep 不收尾 | `trigger='webhook'` 的行至今没有一条到达 `success`：预算耗尽时函数直接返回，运行行留在 `running`，直到 5 分钟宽限期后被定时校准收成 `failure`。界面把「让给下一次」显示成「进行中」再变「失败」 |
| RC3 | 「交给 cron 兜底」这个前提不成立 | GitHub Actions 的 `*/10 * * * *` 在生产实际间隔 50–100 分钟。被推迟的活儿真实等待时间是一小时量级，不是十分钟 |

附带确认为正常的部分：中断行回收器工作正常（RC1 的行确实被收尾），并发抑制工作正常（13:12 有 `skipped` 行），迁移 `027` 的两项均已生效。

## 二、修复方案

### 1. 用自过期租约替换 advisory lock

新表 `reconciliation_leases`（`lock_key` 主键、`holder`、`trigger`、`acquired_at`、`expires_at`）。抢锁是单条语句，靠主键冲突判定归属：

```
INSERT ... ON CONFLICT (lock_key) DO UPDATE SET holder = EXCLUDED.holder, ...
WHERE reconciliation_leases.expires_at < now() RETURNING holder
```

`RETURNING` 的 holder 不是自己就记一行 `skipped` 返回。TTL 默认 30 秒（`RECONCILIATION_LEASE_TTL_SECONDS` 可调），持有期间以 TTL/3 的间隔心跳续租。被冻结的实例停止续租，租约自行到期，不需要任何人来清理。释放带 holder 条件，避免已失去租约的 sweep 删掉后继者的行。

选择租约而非 `pg_advisory_xact_lock` 的原因：事务级锁要求整个 sweep 处在一个事务里，而 sweep 期间要写多行运行状态并调用 GitHub，长事务在 `max: 1` 的连接池上会把后续请求全部堵死。

### 2. 让出预算时把运行行收尾

`withReconciliationBudget` 改为 `withStageDeadline`：不再由路由赛跑，而是 `reconcileWorkflowScope` 自己持有 deadline。`reconciled` / `failed` 改为随每个 stage settle 递增（`allSettled` 的聚合结果只有等全部完成才拿得到），到点即用当前计数收尾：全部结算完按实际成败写 `success` / `degraded` / `failure`，仍有在途的写 `degraded`，`error_message` 记「已让给下一次触发」，`finished_at` 落时间。

副作用：`webhook` 行从此可以到达终态，`listSyncHealth` 面板不再把让让出显示成失败。

### 3. 待校准标记与优先接力

迁移增加 `pr_helper_workflows.reconcile_pending_since`（含部分索引）。推迟、部分失败或整体失败的 sweep 给本次范围内的工作流打戳（`coalesce` 保留最早时间），未收窄分支的 sweep 完整成功时清戳——按分支收窄的 sweep 只看了部分路由，无权替别人清除。

`selectReconciliationBatch` 改为 pending 优先，其次待校准最久，再次尝试时间最旧。实时触发在自己的范围之外额外捎带最多 `REALTIME_CATCH_UP_LIMIT`（4）个同用户的 pending 工作流，且捎带项不受本次投递的分支过滤影响。

效果：被推迟的活儿由下一次 webhook 或收件箱刷新在秒级接力，不再依赖不可靠的 cron 间隔。

## 三、测试

单元测试覆盖纯函数（`reconciliationLeaseTtlSeconds`、`reconciliationLeaseRenewIntervalMs`、`withStageDeadline`、`deferredRunState`、`mergeCatchUpCandidates`、pending 优先的 `selectReconciliationBatch`）与源码守卫（不得再出现 `pg_*advisory*lock`、标记的打戳与清戳条件、服务端模块不得可达任何读 `import.meta.env` 的浏览器模块）。SQL 本身不做 mock，与仓库既有约定一致。

## 四、部署前置

Supabase 需执行迁移 `028_reconciliation_leases_and_pending.sql`。未执行前所有 sweep 都会在抢租约时报错。

## 五、验收标准

1. 一条 `trigger='webhook'` 的行到达 `success` 或 `degraded` 且 `finished_at` 非空，无行长期停在 `running`。
2. 一次 push 的多条投递中，非首条记为 `skipped`。
3. `reconciliation_leases` 中不存在已过期却仍阻塞后继的行。
4. 一次 `degraded` 的 sweep 由紧随其后的触发在秒级接走，而不是由 cron 接走。
