# PR Helper Handoff

> 最后更新：2026-08-15（自动创建 PR 与逐步骤自动合并均已在生产端到端跑通；自动化队列 drain 已上线并完成首轮实测；调用预算经按小时复核后已降级为阈值观察，当前第一优先级见《2026-08-15 drain 首轮实测与优先级调整》）
> 当前事实来源：[`docs/current-state.md`](docs/current-state.md)。历史设计和计划不应作为当前需求或上线状态的依据。
> 自动创建 PR 链路的诊断与修复方案见 [`docs/auto-create-pr-remediation.md`](docs/auto-create-pr-remediation.md)。

## 当前状态

- 当前分支：`feature/20260722`。
- 用户已确认本批代码已上线 Production。
- 2026-08-03 验证报告见 [`docs/verification-report.md`](docs/verification-report.md)：真实 E2E 已通过 GitHub App 授权、PR 创建、严格门禁、应用内合并、合并后 Actions 与多路径汇聚；未通过项均已明确标注。
- 当前本地验证已通过：`npm test`（28 个文件 / 513 项）、`npx tsc --noEmit`、`npm run build`。后台自动创建 PR 代码未改变现有手动流程行为；浏览器 E2E 已修复并全部通过（9/9）：Playwright 端口从 Vite 默认的 4173 挪到 4373，避免 `reuseExistingServer` 复用别的项目的开发服务；用例改为先展开看板卡片再点步骤，看板编辑按钮标签改判「编辑」。
- 最近本地提交 `b61e2d3e` 新增“测试已保存配置”：服务端解密保存的 AI 凭据并实际调用模型连接测试，15 秒超时，只返回成功或脱敏错误，不返回 API Key；生产端已验证连接成功（`agnes-2.0-flash`）。
- 最近本地提交 `510a63c9` 为自动 PR 动作增加 AI 请求 20 秒超时、输出上限和过期 `running/paused` 动作回收重试，避免一次超时永久阻塞幂等动作。
- Supabase 迁移 `001`–`031` 已执行；`021`–`023` 对应代码已部署 Production，待加密同步线上回归、Cron 清理观察和团队多账号验收。操作审计读取已改为现有 `inbox` 函数的 `resource=operation-audit` 分流，未增加 Serverless Function 数量；Production 已显示流程更新、创建/合并 PR 记录，CSV 导出按钮可用。`019` 已将 `stage_id` 设为阶段持久化数据的正式主键/外键身份。
- Vercel 已配置 `CSRF_ALLOWED_ORIGINS=https://pr-helper.pages.dev`，覆盖 Production 和 Preview。
- PR #172 的首个 Vercel Preview 失败原因为 Vercel 对 `api/` 完整 TypeScript 编译，而仓库原 `tsconfig.json` 仅包含 `src/`；随后又因 Hobby 计划 Serverless Function 数量限制在部署输出阶段失败。已将 `api/` 纳入本地检查、修复类型错误，并把自动化与 AI 凭据入口合并到 `/api/workflows` rewrite；提交 `93c00d41` 后 Vercel Preview、CI 和 Preview Comments 全部通过。

## 2026-08-14 实时校准修复（已部署生产）

- 自动创建长时间不触发的根因不在自动化闸门，而在校准链路：webhook 与收件箱刷新在返回响应之后才 `void reconcileWorkflowStages(...)`，函数随即被冻结，`trigger='webhook'` 的行全部停在 `running` / `stages_total=0`；一次 push 触发 5 条投递同时抢 `max: 1` 连接池；定时校准的批量排序按阶段数据取最新值，解析不出路由的工作流永久占用名额，轮转最坏 4–5 小时。
- 本地已落地：按事件分支收窄校准范围、在预算内 `await` 校准后再返回、`pg_try_advisory_lock` 抑制同仓并发、提前写入 `stages_total` 并回收中断行、按尝试时间轮转。计划与证据见 [`docs/superpowers/plans/2026-08-14-realtime-reconciliation.md`](docs/superpowers/plans/2026-08-14-realtime-reconciliation.md)，实现清单见 [`docs/auto-create-pr-remediation.md`](docs/auto-create-pr-remediation.md) 第十节。
- 部署前置：Supabase 需执行迁移 `027`（`reconciliation_runs.state` 允许 `skipped`、`pr_helper_workflows.last_reconcile_attempt_at`）。

## 2026-08-14 校准租约与待校准接力（已部署生产）

- 上一批部署后由生产数据暴露三个残留缺陷：会话级 advisory lock 在实例被冻结后不会释放（一条 cron 行挡了同仓 8.7 分钟）；超预算的 sweep 直接返回不收尾，`trigger='webhook'` 至今没有一条到达 `success`；GitHub Actions 的 `*/10` 计划在生产实际间隔 50–100 分钟，「交给 cron 兜底」不成立。
- 本地已落地：`reconciliation_leases` 自过期租约（TTL 30 秒、TTL/3 心跳续租、holder 守卫释放）替换 advisory lock；`withStageDeadline` 让出预算时按当前计数写终态并落 `finished_at`；`reconcile_pending_since` 标记推迟或失败的工作流，实时触发优先接力最多 4 个，不再等 cron。计划与证据见 [`docs/superpowers/plans/2026-08-14-reconciliation-lease.md`](docs/superpowers/plans/2026-08-14-reconciliation-lease.md)，实现清单见 [`docs/auto-create-pr-remediation.md`](docs/auto-create-pr-remediation.md) 第十一节。
- 生产事故已修复并上线：`api/_lib/workflows-store.ts` 从浏览器模块 `src/lib/github.ts` 引入函数，该模块顶层读 `import.meta.env`，在 Node 下模块加载即崩，`/api/github/session` 返回 `FUNCTION_INVOCATION_FAILED`。已内联该调用并新增源码守卫测试，覆盖整类越界。
- 部署前置：Supabase 需执行迁移 `028`（`reconciliation_leases` 表、`pr_helper_workflows.reconcile_pending_since`）。未执行前所有 sweep 会在抢租约时报错。
- 后续本地已落地（**已部署**，2026-08-17 核实在 `main`）：生产埋点证明校准的瓶颈是 `max: 1` 连接池而非 GitHub 往返（单个 stage 6 秒里 GitHub 只占 2.4 秒，`deploy` 阶段独占 3.2–4.6 秒，让出预算的收尾 UPDATE 还要再等 3.4 秒），连接池已放开到 4；勾选服务端自动创建后会立即触发一次 `manual` 校准，先有提交后勾选不再等下一次 push。自动合并当时未参与即时触发，理由是保存勾选不等于授权合并生产。详见 [`docs/auto-create-pr-remediation.md`](docs/auto-create-pr-remediation.md) 第十二节。
- 已落地并**已部署**（2026-08-17 核实在 `main`：合并勾选的处理器调 `confirmImmediateAutomation('merge', …)`，与 [`api/workflows.ts`](api/workflows.ts) 的 `create || merge` 即时触发同时在位，绑定未被拆开）：上述不对称已判定为错误结论（自动合并作用于已创建的 PR，推迟不减少后果，只是延后到用户注意力离开时）。已把「对称化触发」与「勾选时确认」绑在一起落地，不可拆开——没有确认的静默立即合并才违反 `AGENTS.md` 第 5 条。同时明确反选是尽力而为而非取消保证（窗口约 1–3 秒）。详见 [`docs/superpowers/plans/2026-08-14-automation-toggle-activation.md`](docs/superpowers/plans/2026-08-14-automation-toggle-activation.md) 与第十三节。
- 部署后验收四项：一条 `webhook` 行到达 `success`/`degraded` 且 `finished_at` 非空、无行长期停在 `running`；一次 push 的非首条投递记 `skipped`；`reconciliation_leases` 无已过期却仍阻塞后继的行；一次 `degraded` sweep 由紧随其后的触发在秒级接走。

## 2026-08-15 生产实测与本批修复

- 两条自动化链路都已在生产跑通：`create-pr` 47 次成功 / 1 次 `paused`，`merge-pr` 37 次成功 / 10 次 `paused` / 2 次仍在 `queued`。10 次 `paused` 里 7 次是门禁未全绿的正确行为，另 3 次是 GitHub 超时（`CONNECT_TIMEOUT`）。门禁为红一项已在沙箱验完，结论是守卫落在合并侧、创建侧不可达，原措辞应改为「门禁为红不自动合并」；顺带暴露 ruleset 审批要求不可见并已修（见 remediation 第十节）。仍未验项已清空：幂等命中记成功已于 2026-08-15 在沙箱验完（remediation 第十七节）。自动化验收清单至此没有未验项。
- 新增 `reconciliation_runs.github_calls` / `github_ms` 遥测后，真正的剩余工程问题被量化出来：12 小时内定时校准跑 120 轮共 8,275 次 GitHub 调用（每轮约 69 次、平均 16.3 秒），webhook 只有 1,095 次、manual 54 次——约 88% 的 installation 配额来自定时扫描，这正是 08-14 配额耗尽、自动合并被迫暂停的来源。**该结论当日晚间即被按小时复核下调，2026-08-18 再次复核仍成立**：这里的 88% 是触发方之间的占比，不是配额占用率；按小时算常态 876–1,182 次、历史峰值 1,702 次（08-17 23:00），占 5,000 次/小时基线的 18%–34%。现按阈值观察，见下方第二节。
- 本批已修并上线：保存失败不再丢弃配置；实时 sweep 不再拖慢保存；重试预算不再花在 provider 明确拒绝上；无版本历史的历史流程重新可保存（生产确认 version-less 记录归零）；排序不再回滚版本号（生产确认 33 个流程 position 唯一、跨 0–32）；自动化队列 drain 具备自愈与抛错停机保护。
- 数据与结论细节见 [`docs/current-state.md`](docs/current-state.md) 的《2026-08-15 生产实测结论》与《2026-08-15 本批修复》。

## 2026-08-15 drain 首轮实测与优先级调整

- drain 已在生产跑过一轮（Actions run `31880783398`）：首次 sweep 取消 6 条被后续提交取代的动作、回收 1 条并退还误扣尝试，未结束动作从 7 条降到 1 条。「恢复必须等下一次 push」这个耦合已被打断。
- 同一轮暴露了 drain 自身的缺陷：`id 84` 每 75 秒被执行一次、每次抛错，行却一直停在 `queued attempts=0`。执行器在原子领取之前抛错时不写裁决，而 drain 只记日志不动行，于是永不收敛。已修并有测试覆盖：抛错时把原因写回该行并置 `paused`，UPDATE 以 `state IN ('queued','running')` 为条件，不覆盖执行器自己写下的裁决；失败明细随响应返回，下一次 sweep 自己就能说出原因。
- 调用预算按小时复核后降级：24 小时约 9,976 次调用，峰值小时 1,204 次，占个人账号 GitHub App 基线 5,000 次/小时的约 24%；29 个流程翻倍到 60 个也才约 48%。08-14 的配额耗尽发生在分批与租约修复之前，不能作为当前扫描强度的证据。
- `duration_ms` 口径修复已在生产生效：修复前 `webhook` 行最大值曾达 4,166 秒（把回收前的等待计入），部署后近 70 分钟内 `webhook` 最大 10.4 秒、`cron` 最大 33.6 秒 / p90 22.3 秒。
- 29 个流程（不含两个 sandbox）状态干净：36 个阶段行中 35 个 `ahead=0`，唯一待发布的是 `soft-desk-landing dev->main ahead=2`，正被 `id 103` 那条超时 `paused` 的 `create-pr` 拦着。

### 待办列表（按优先级）

> 用户 2026-08-15 决定：自动化进度条 UI 后置，先解决自动创建 / 自动合并本身的不稳定。

**一、自动创建 / 自动合并稳定性（当前唯一主线）**

1. **`id 84` 重排已关闭：bigint 修复已在生产被真实执行验证（无待办，仅留结论）**。`6aa011c2` 部署后，12:36–13:11 之间 `id 113`–`121` 共 8 条动作 `succeeded`（`attempts` 1–3），`id 111` 被判 `superseded` 而 `cancelled`——这是 drain 上线以来第一次真正执行动作，此前首轮 `executed: 0` 是每行都在原子领取前抛错，不是队列为空。`id 84` 本身拿不到真实裁决了：它 `created_at` 为 08-15 01:03:20，人工重排发生在 13:03:30，已过 `AUTOMATION_ACTION_STALE_MS`（12 小时）30 秒，而 `automationDrainDecision` 的 stale 判定排在 execute 之前，因此只会被下一次 sweep 标记 `cancelled / 超过自动化时限，未再尝试`。不必再干预。
2. **瞬时失败的重排路径已实现，待生产验证（当前第一优先级）**。drain 现在也读 `paused`，`automationDrainDecision` 只在「有失败原因且 `automationAttemptWasReached` 判为未触达供方」时返回 `requeue`，并要求未被取代、仍在 12 小时窗口内、距上次更新超过 15 分钟（`AUTOMATION_TRANSIENT_REQUEUE_COOLDOWN_MS`）、`attempts < 3`（`AUTOMATION_TRANSIENT_REQUEUE_MAX_ATTEMPTS`）。冷却不可省：领取前抛出的故障不计 `attempts`。重排以读到的 `state = 'paused'` 为条件写入，真实裁决胜出。批次改按 `ORDER BY (actions.state = 'paused'), actions.created_at`，防止最老的 `paused` 行占满批次饿死队列行。7 条「门禁尚未全绿」是正确终态，不动。**更正**：此前写「正则漏掉 `CONNECT_TIMEOUT`」是错的，`timed? ?out` 忽略大小写已匹配 `TIMEOUT`。超窗的瞬时失败改判 `cancel / stale` 而不是继续 `skip`：没有别的机制会重试它，留在 `paused` 就是把一个已死的意图长期钉在失败中心里；GitHub 已给出的裁决无论多老都保持 `paused`，那是操作者唯一的记录。因此 `id 6` / `58` / `80` 会被清成 `cancelled`，不会被救回；重排路径本身的生产验证要等下一次真实的瞬时故障。`id 84` 已于 2026-08-15 13:29 按预期清成 `cancelled / 超过自动化时限，未再尝试`。

3. **实时校准预算已按触发方分开，生产已验证（无待办，仅留结论）**。一个 8 秒常数同时服务三种触发方，但约束相反：webhook 的响应体无人读，要的是把这次事件的 1–2 个步骤跑完；保存与收件箱刷新有人在等，让出由 `reconcile_pending_since` 接力，不算丢工作。故 `webhook` = `WEBHOOK_RECONCILE_BUDGET_MS` 25000、`manual` / `inbox_refresh` 保持 8000，环境变量 `REALTIME_RECONCILE_BUDGET_MS` 仍可整体覆盖。外层兜底改为 `realtimeReconcileCeilingMs(budgetMs)` = `min(budgetMs + 15s, 45s)`，不再是 `budgetMs * 2`。实测依据：webhook 成功 p50 7.9 秒（单步骤的 GitHub 往返就接近整份预算），34% 投递让出、让出的 195 个步骤里 151 个白做；让出耗时最小 9.86 秒（租约与周边查询在预算之外约 1.9 秒）；最大 16.4 秒正压在旧的 16 秒外层兜底上，被甩掉的 sweep 留下 `running` 行，5 分钟宽限后记成「实例被回收」——24 小时 25 条 webhook `failure` 即此。**2026-08-15 14:49 部署后核对**：webhook 12 次成功、让出 0、被回收 0（部署前 24 小时为 292 / 149 / 60，即 29.7% 让出、12% 被回收）；webhook p50 9.0 秒、最长 17.2 秒，全部落在旧的 8 秒预算之上，说明这些在改之前都会让出。cron 11 次全成功，p50 14.1 秒，共校准 130 个步骤。`reconcile_pending_since` 待补齐为 0，无积压。`manual` / `inbox_refresh` 部署后暂无样本（需界面操作才产生），这两个按设计仍是 8 秒并靠计划清扫兜底，历史让出率偏高（54% / 60%），是否退化要在日常使用中继续看。**2026-08-15 20:45 复核（修正上一行的「被回收 0」）**：那是部署后 12 次的小样本假象。9 小时完整口径为部署前成功 78 / 让出 61 / 被回收 10，部署后 146 / 5 / 11——让出率 44% → 3% 是预算拆分的真实成效，被回收率 11% → 7% 基本没动，即这一类既没消失也没回归。成因已定位且与「实例真被回收」无关，见第 10 项。
4. **失败中心 9 条假待办已修，生产已验证（无待办，仅留结论）**。首页「需要处理」显示十项，核对后 9 项失效：全部是被同路线更新动作取代的 `paused` 行，取代它们的那条都已 `succeeded`（ids 11/13/15/20/22/58/71/80/99）。根因是 08-15 新加的 `paused` 分支先判失败原因、GitHub 裁决直接 `skip`，永远走不到 `hasNewer`，而 `queued` / `running` 本来就有 `superseded` 出口。已把 `hasNewer` 提到该分支首位判 `cancel / superseded`。真待办只有 1 项：`E2E Failure and Dynamic Rule` 的 `fix/failure-e2e`（PR #4）Actions 失败。**2026-08-15 14:50 部署后核对**：九条在同一个 drain 批次里被清成 `cancelled / 已被后续提交的自动化动作取代`（约 0.75 秒一条），库里已无任何 `paused` 行，失败中心只剩那 1 项真待办。
5. **时钟已搬进数据库，生产已验证（无待办，仅留结论）**。近 7 天相邻 cron 送达的间隔：p50 46 分、p90 82 分、最大 152 分，而一次送达只覆盖约 7.5 分钟（`SWEEPS: 6` × 75 秒），约 85% 的时间没有 drain 在跑；被回收实例留下的已领取行本该 `AUTOMATION_ACTION_ABANDON_MS`（120 秒）后就能接手，实际最坏等 2.5 小时。迁移 030 用 `pg_cron` + `pg_net` 打这两个端点：**drain `*/2`**（对齐 abandon 窗口，队列空时不产生 GitHub 调用）、**reconcile `*/5`**（每次扫掠约 69 次调用，5 分钟一次 = 828 次/小时；2 分钟则单这一项 2070 次/小时，直接压第 6 项那条 2500 次/小时的线，故不取）。密钥不进仓库：迁移只建 `public.pr_helper_cron_ping(endpoint)`（`security definer`），调用时从 Vault 取 `pr_helper_cron_secret`，取不到就抛错——否则只会在 `net._http_response` 里留一片 401，看着像端点坏了。`timeout_milliseconds` 给 90 秒，因为 pg_net 默认 5 秒会把正常干完活的调用记成超时。Actions 作业保留为兜底但 `SWEEPS` 6 → 1（重叠无害：抢不到 `reconciliation_leases` 的触发记 `skipped`）。**不采用「把 Actions 循环拉长」**：仓库是 public、分钟数免费，但 p90 82 分、最大 152 分超出任何单次作业的合理循环时长，且计划工作流在仓库连续 60 天无提交后会被 GitHub 自动停用，覆盖率仍挂在会漂移的调度器上。**你要做的一次性操作**：在 Supabase SQL Editor 执行 `select vault.create_secret('<CRON_SECRET 的值>', 'pr_helper_cron_secret');`，然后应用迁移 030。**2026-08-15 17:06 UTC 上线后核对**：`net._http_response` 前 5 条全是 200,时间落在 17:06 / 17:08 / 17:10×2 / 17:12——drain 每 2 分钟、reconcile 每 5 分钟(17:10 两条即两个作业同刻),无 401、无超时。17:10:03 的 cron 扫掠成功校准 10 个步骤、57 次调用。**实测调用量比按 `*/5` 折算的高**:17:06–17:39 共 33 分钟内 cron 8 次扫掠 522 次调用、webhook 68 次 155 次调用,合计约 1230 次/小时,约为 2500 警戒线的一半。多出来的扫掠来自 Actions 兜底作业的送达(它现在每次只扫一遍,但送达本身会叠在 `*/5` 之上)。若日后逼近警戒线,第一个可动的杠杆是把兜底作业的 `schedule` 放稀或让它只打 drain 不打 reconcile。密钥同时轮换过(旧值在 Vercel 上是 Sensitive、取不回来),新值只存在于 Vercel、GitHub Secret、Supabase Vault 和 `~/.config/pr-helper/cron-secret.txt`,未进仓库。只读凭据 `prh_readonly` 看不到 `cron` schema(`permission denied`),`net._http_response` 可读,后续核对走后者。
6. **内联合并已删，自动化合并只剩 drain 一条执行入口（已实施、已部署、已验收，无待办）**。方案与验收记录：[`docs/superpowers/plans/2026-08-17-drop-inline-automation-execution.md`](docs/superpowers/plans/2026-08-17-drop-inline-automation-execution.md)。两点纠正了原来的表述：（a）执行器只有一份，分叉的是**准入策略**——内联绕过退避 / `hasNewer` 取代取消 / 12 小时过期 / attempts 上限；（b）drain 的门禁退避规则是按「内联存在」写的，删除必须同批把 sweep 改成「信号源」（门禁转绿时清 `failure_reason` 并 bump `updated_at`），否则门禁清除后的合并延迟会从秒级掉到最长 30 分钟。**取 B 不取 A**：47 / 26 两个重试峰值全部来自 merge，删内联合并即可清；创建侧 `max(attempts)` 只有 3，drain 那套规则套上去实测拦不到东西，不值得用 72% 动作从 8.6 秒变 65 秒去换，故 `scheduleServerAutoCreate` 的内联保留。**2026-08-17 23:39 UTC 部署后验收（沙箱 `E2E Failure and Dynamic Rule`）**：创建仍 7.4 秒（动作 247）；动作 239 的 Approval 23:46:47 → reason 于 23:47:08 被清 → **23:48:07 合并，距 Approval 80.2 秒**，而它的退避窗口本会把它压到 23:58:04（慢约 11 分钟），信号源改造的价值被直接量到；动作 248 卡门禁期间历经 4 次成功 sweep 而 `attempts` 恒为 0（部署前每次都是一轮内联尝试 + 约 6 次 GitHub 调用），47 的生成机制归零。**一个原定判据作废**：「`自动合并 PR 失败` 字符串归零」不可用——成功时 `failure_reason` 被写 NULL，该计数部署前就已是 0。
7. 迁移 `031`（`reconciliation_runs.claimed_workflow_ids`）已执行并部署，列已就位、cron run 认领 8 个 / webhook run 认领 1 个。**2026-08-15 19:35 已等到真实样本并验完，无待办**：run 3611（`webhook`，19:29:20 起，认领 `bayernjf/pr-helper-1785096146747-e87zs`）在 19:35:02 被 cron 记 `failure`，同一条语句把该流程标回 `reconcile_pending_since`；**19:35:03 的 cron 扫掠立刻接手**，把它连同 9 个步骤全部校准并清空标记。名额归还路径已在生产闭环。
8. 等门禁的动作退避（`1e02a8a0` + `6a0ede17`）已部署并在生产验完，**无待办，仅留结论**：排空自身的计数就是证据——19:22/19:24/19:26 三次都是 `examined 2 / executed 1 / skipped 1`（那个 `executed` 就是动作 205），部署后 19:30 变成 `examined 2 / executed 0 / skipped 2`，`attempts` 停在 46。时效未受影响：19:31:58 给 PR #12 approve，19:32:01 收到 `pull_request_review/submitted`（该窗口内唯一事件），19:32:20 合并、19:32:21 动作 205 `succeeded`，**从事件到合并 19 秒**。这次执行不可能来自排空——19:32:00 那次排空看到的 `updated_at` 是 19:28:04，而 attempts=46 对应封顶的 30 分钟等待，必然 `skip`。顺带记一笔：`pull_request_review` 不在 `webhookBranchesForEvent` 的 switch 里，返回 null 即不收窄范围，一次 review 会触发全量扫掠（约 69 次调用）。review 频次低，暂不动；若日后调用量逼近警戒线，这是一个可收窄的点。
9. **自动化验收清单已清空，无待办，仅留结论**。幂等命中记成功于 2026-08-15 20:20 在沙箱验完（remediation 第十七节）：动作 219 停在 `queued`、PR #13 由 `bayernjf` 本人合掉，排空执行后记 `succeeded` 且审计带 `metadata.idempotent = true`，`mergedBy` 始终不是 App，即从未发出合并调用。门禁为红一项见 remediation 第十节。造场景的脚手架**有意保留**在 `bayernjf/pr-helper-e2e-sandbox`：分支 `fix/red-gate-e2e`（已合入 dev，PR #12 已关闭）与 `.github/workflows/red-gate-e2e.yml`（分支内限定触发，缺 `.pr-helper-e2e/gate-green` 即失败）。别删，下次造场景直接复用；注意该工作流必须带 `actions/checkout@v4`，否则标记文件不在盘上、门禁永远为红。

10. **实时天花板不写判决、内联合并重复读门禁，两处均已修，已部署，(a)(b) 均已验完，无待办**。(a) `reconcileRealtime` 的外层天花板此前只是甩掉 sweep 并返回 `deferred`，被甩掉的 `running` 行要等 5 分钟宽限后由 cron 记成「校准中断：函数实例在完成前被回收」——9 小时内 21 条 webhook `failure` 全部由此而来，`stages_reconciled` 一律为 0，而它们其实都是设计内的让出。天花板覆盖的不只是阶段预算，还有租约等待和路由查询，所以这些行 `stages_total` 只有 0/1/2、`github_calls` 为 NULL：时间花在阶段工作之前。现改为把 sweep 开出的 run id 收集起来（`onRunStarted`），输掉竞速时就地记 `degraded` + `校准超出实时上限，已交给下一次触发接手`，`duration_ms` 按真实运行时长写入（与收割器不同，这里就是抛下的时刻），并在同一条语句里把认领的流程标回 pending，不再等收割器。(b) 校准的内联路径每收一次 webhook 就无条件把等门禁的合并动作再执行一遍，而门禁退避只管排空（第 8 项）——动作 205 因此重试 47 次、跨 75 分钟，每次都重读一遍 PR / 检查 / 评审 / 保护规则（约 6 次调用）却不可能得到不同答案，`attempts` 也就不再是可用的健康信号。现把校准刚算出的门禁直接喂给 `automationMergeOutcome`，只有「可重试的暂停」才跳过内联执行，等门禁的原因写在 `queued` 行上且不动 `updated_at`（否则每次投递都把退避窗口往后推，排空永远轮不到当网）；门禁一绿仍在当次事件里合并，时效不变。**部署后核对结果（2026-08-17）**：(a) **通过**——webhook 的 `failure / 校准中断：函数实例在完成前被回收` 最后一条是 08-16 18:27:42，落在部署之前，此后归零；同期出现的是 `degraded` + 新措辞。(b) **样本不足，暂不结论**——`attempts` 最大值仍是 26（动作 221/222），但它们创建于 08-15 20:23、08-16 08:24 已以「超过自动化时限，未再尝试」终结，**早于部署**；部署后产生的动作只有 3 个（236/237/238，`attempts` 1/0/1），个位数但不足以判定。**2026-08-18 00:35 已等到真实的等门禁场景并验完**：动作 248（`merge-pr`，23:44:55 创建，卡在「PR 还需要 1 个 Approval」）在 **45 分钟里 `attempts` 只涨到 4**，而部署前的动作 205 是**75 分钟涨到 47**。同期另两个未被门禁拦住的动作 247（`create-pr`）与 249（`merge-pr`）都是 `attempts` 1、一次成功。重试节奏已由退避而非事件频率决定，`attempts` 重新成为可用的健康信号。附注：昨天曾记「动作 248 历经 4 次成功 sweep 而 `attempts` 恒为 0」，那是删内联当天的瞬时读数；`attempts` 由 drain 的执行尝试推进，随退避窗口逐次加一，涨到 4 是设计内行为，不是回归。

11. **交互式校准预算实验（已部署生效，观察中，第一优先级）**。方案与判读规则：[`docs/superpowers/plans/2026-08-18-realtime-reconcile-budget-experiment.md`](docs/superpowers/plans/2026-08-18-realtime-reconcile-budget-experiment.md)。第 3 项留下的「`manual` / `inbox_refresh` 仍是 8 秒，是否退化要在日常使用中继续看」现在有答案了：**有 `github_calls` 记录的 30 次运行里 23 次 degraded（77%）**。两个诊断被数据推翻，都写进了方案文档，此处只留结论——（a）`github_calls = 0` 不是抢租约空转，`budget.calls` 在 `reconcileStageWork` 返回之后才累加（`api/_lib/workflows-store.ts:1605-1609`），抢不到租约的路径立刻写 `skipped` 就返回（`:1743-1747`，即那些 `duration_ms ≈ 375` 的行）；（b）「degraded 罕见」来自只看 24 小时的 3 次样本。故 23 次全属预算不够，不存在争抢类。**你要做的**：production 设 `REALTIME_RECONCILE_BUDGET_MS = 25000` 并重新部署一次（env var 不热加载）。取 25000 而非 20000，是因为它等于 `WEBHOOK_RECONCILE_BUDGET_MS`，可使这个一刀切覆盖（`:1883-1887`）不把 webhook 降下来。**判读规则先定死**：占比明显下降 → 预算是瓶颈，再决定要不要给这两个 trigger 拆独立常量；占比没动 → 卡的是某个会挂的 stage，**不要继续加预算**，转「交互请求不再同步等 sweep」。代价已知并接受：卡住的 stage 会占住保存 / 刷新请求最多 25 秒（极端 40 秒）。具体操作（CLI 已 link 到 `pr-helper` 项目）：

    vercel env add REALTIME_RECONCILE_BUDGET_MS production   # 交互式输入 25000；branch 留空表示所有 production 部署
    vercel env ls production                                 # 只能看到名字，本项目所有变量都是 Sensitive
    vercel ls --prod                                         # 取当前生产部署 URL
    vercel redeploy <上一步的 URL> --target production        # redeploy 没有 --prod，要 URL + --target；或照常 merge 到 main 触发 git 部署。这一步不能省

    vercel env rm REALTIME_RECONCILE_BUDGET_MS production     # 回退，同样要再部署一次

生效判据：部署后在界面点一次手动刷新，看最新那条 `inbox_refresh` 的 `duration_ms`——明显超过 10 秒（约 26 秒）即新预算已在用；仍卡在 9.9 秒说明变量没生效或部署没带上。**2026-08-18 00:28 UTC 已确认生效**：run 5368（`inbox_refresh`）55 个 stage、校准 36 个、**39962ms**，而旧 ceiling 是 `min(8000+15000, 45000) = 23000`，跑不到 40 秒。同时暴露一件更要紧的事：该账号 stage 总量就是 55，全量刷新的规模超出任何请求预算，40 秒只做完 65%，且其中约 15 秒花在阶段预算之外的路由解析上（`:1781-1788` 在 `withStageDeadline` 之前）。所以若一周后占比没降，出口是「交互请求不再同步等 sweep」而非继续加预算。

12. **收敛健康探针（已部署并验收）**。08-17 的 GitHub 故障期里定时校准连续 degraded（那四个小时分别 3/14、13/14、11/14、3/14），但 `/api/cron/reconcile` 一律返回 200，Actions 全绿，**没有任何人被告知**。这次补的不是「degraded 就报警」——同期每次 degraded 仍校准了 14~15 个 stage，系统一直在收敛，根因是无从处置的上游故障，degraded 是机制不是危害。所以判据落在结果上：新增只读 `GET /api/cron/health`（`api/cron/health.ts`，同样只认 `CRON_SECRET`），最老的 stage 投影年龄超过 `STAGE_UNCONVERGED_THRESHOLD_SECONDS`（默认 45 分钟，可用同名环境变量覆盖）时返回 **503**，否则 200；响应体带 `oldestStageAgeSeconds` / `staleStageCount` / 最近一小时 cron 的 `total` 与 `degraded`。45 分钟取自实测：健康态下 55 行 stage 的最老投影 13 分钟、p90 13、p50 6（cron `*/5`、每轮 8 个流程），阈值约为观察峰值的 3.5 倍。`.github/workflows/reconcile-pr-helper.yml` 加了 `Report convergence health` 步骤，非 200 即 `exit 1`，且 `if: always()`——sweep 本身失败时这些数字最有用。空 stage 表判健康（新装账号和刚清理过的账号不该报警），单测已覆盖「刚好等于阈值不触发」「超过触发」「空表不触发」。**刻意没做的两件事**：不把判决塞进 `/api/cron/reconcile` 的状态码（会把「设计内让出」和「系统不健康」混成一件事，还会把 `net._http_response` 里灌满非 200）；不靠 UI 提示（「当时没人在看」这件事 UI 修不了）。**待你验收**：合并部署后，看下一次 scheduled run 的 Job Summary 里 `HTTP 200` 与那几个数字；另外我无法验证 GitHub 是否会就 scheduled workflow 失败给你发邮件，兜底信号是 Actions 页上的红叉。**2026-08-19 已验收**：生产部署创建于 08-18 20:17（晚于这批 commit 的 08-18 08:48），此后 5 次 scheduled run 全绿且 `Report convergence health` 步骤 success——该步骤只有 HTTP 200 才不 `exit 1`（curl 失败会置 `status=000`，同样失败），故成功即等于端点可达、`CRON_SECRET` 认证通过、判定健康。同时直接查库复算了同一组样本：55 行 stage，最老投影 **1062 秒（17.7 分钟）**，距 2700 秒阈值余量充足，超过 15 分钟的 19 行；最近一小时 cron 14 次运行、0 次 degraded。curl 把响应写进文件，所以 run log 里看不到那几个数字，要读得去 Job Summary。

- **自动化进度条 UI 的完整方案**：只读诊断切片已于 2026-08-15 落地（`/api/inbox` 多带 `automation` 字段，受阻动作显示在失败中心、看板计数、泳道徽标、步骤抽屉和流程详情页五处）。仍后置的是 [`docs/automated-workflow-plan.md`](docs/automated-workflow-plan.md)《自动合并进度条》的完整方案：百分比、接管对话框、`unpause` 都是写路径，依赖第 2 项的「瞬时 vs 终态」分类先定下来。
- **reconciliation 调用预算**：改为阈值观察，峰值小时越过约 2,500 次（基线 5,000 次/小时的一半）再设计模型。**2026-08-18 复核**：常态 876–1,182 次/小时，历史峰值 1,702 次（08-17 23:00），距警戒线仍有余量。
- **让出（`degraded`）的瓶颈是时延而非调用数**：249 次 `degraded` 里有只花 10–11 次调用就超时的样本（08-18 12:01 webhook、12:13 inbox_refresh），说明单次 GitHub 往返的耗时才是约束，按调用数设上限治不到它。真要收敛，先做 ETag / `If-None-Match`（304 不计配额、往返也短），再按剩余时间预算切分单轮工作量。

**三、只能由用户执行**

- **轮换 `prh_readonly` 口令**：该口令曾出现在会话记录中。`alter role prh_readonly password '<新口令>'`，并同步更新 `~/.config/pr-helper/db.env`。
- 可选加固：给 agent-dev 的 `dev`/`main` 加 `quality` 必需检查（两者当前均未保护）；给 word-base 的 `deploy-cloudflare` 补 `environment: Production` 以便出现部署 URL。

## 2026-08-17 定时校准超时导致 Actions 失败（已修，已部署并验收）

- 症状：`Reconcile PR Helper monitoring` 定时作业失败。两次失败（run `31937450235` 08:49、`31949974704` 13:29）日志一致：`curl: (22) ... 504` + `FUNCTION_INVOCATION_TIMEOUT`。`SWEEPS: 1`，一次失败即整个作业失败。
- 根因是**定时校准没有预算**。`reconcileWorkflowStages` 的注释原本写「定时扫掠独占整个请求，所以它等」——但它并不独占平台上限：跑过 60 秒的函数被就地杀掉，调用方收到 504，`reconciliation_runs` 那行留在 `running`，5 分钟后被收割器记成「校准中断：函数实例在完成前被回收」，`stages_reconciled = 0`、`github_calls` 为 NULL。此前记在待办里的「cron 1.4% 被回收残留」和这次 CI 失败**是同一件事**，不是两件。
- 数据（30 小时口径）：cron 成功 392 次，p90 22.3 秒、最长 32.8 秒；失败 3 次全是上述被回收，`duration_ms` 为 NULL（死在测量自己之前）。也就是说健康扫掠离上限还有一倍余量，只有离群的那几次会撞线。
- 修法与实时触发一致：给定时扫掠一个 `CRON_RECONCILE_BUDGET_MS = AUTOMATION_FUNCTION_CEILING_MS - 20_000`（即 40 秒，可用同名环境变量覆盖）。40 秒的留白覆盖扫掠前的收割与选批、扫掠后的收尾写入和保留清理；同时高于 32.8 秒这个「实际跑完的最慢一次」，所以**现在能跑完的扫掠不会因此开始让出**。超时的那一次改为记 `degraded` + 置 `reconcile_pending_since`，由下一个 `*/5` 接手，端点返回 200，作业不再失败。
- **有意不动**兜底作业的判定逻辑：`SWEEPS` 全失败就退出 1 是对的，真出故障应该响。加宽容忍度只会把下一次真故障藏起来。
- **修复带来一个观测盲区，值得单独记一笔**：`degraded` 返回 200，所以上面那场 26 次连续降级期间，`Reconcile PR Helper monitoring` 作业**全是绿的**（13:52 / 14:25 都 success）。好处是不再被上游故障误报成 CI 红；代价是「持续降级」在 Actions 上完全看不见，只能查 `reconciliation_runs`。单次让出确实不该报警，但连续降级两小时应该有信号——加什么信号是个产品问题，尚未设计，先记在这里免得丢。
- **2026-08-17 06:21 部署（`f2716dcd`）后核对，通过**：`失败 / 校准中断：函数实例在完成前被回收` 历史共 68 条，最后一条 06:00:03，正好落在部署之前；部署后归零。取而代之的 `degraded / 校准未在预算内完成，已让给下一次触发` 出现 3 次（cron 1 次 13:09、webhook 2 次 14:54–14:55），被让出的流程都在后续 tick 被认领、`reconcile_pending_since` 全部清空。
- 验收赶上了一场真实故障，比构造场景更有说服力：13:55–15:45 GitHub 处于 major outage（API / PR / Actions 全部 `major_outage`），校准连续 26 次 `degraded`，报错文本换了四种（`Resource not accessible by integration`、`Internal Server Error`、`We couldn't respond to your request in time`、`No server is currently available`）。修复前这种上游变慢会被就地杀成 504，现在是按预算让出、GitHub 一恢复积压即被追平。

## 2026-08-17 流程归档（已部署并验收）

- 目的是给不再需要校准的流程一个退出口，顺带收敛 reconciliation 的调用预算：每一轮扫掠都在为范围内的每个流程付 GitHub 调用。归档让一个流程彻底退出校准范围（cron / webhook / manual / inbox_refresh 全不进），不上看板、不进失败中心、不做预检与配置告警，但历史、步骤、版本、审计全部保留，随时可恢复。**本版只做归档，不做静音，也不做批量与自动归档。**（原先设想的落地对象是生产上 35 个流程里的 `*-landing`，但那批仍在维护，见本节末；归档因此暂无存量落地对象，能力先就位。）
- **存储写在 `payload` 里，不加迁移**：`Workflow.archived?: true` 随现有 `upsertWorkflow` / 浏览器同步 / `encrypted-sync` 流转，并自动进入 `workflow_versions` 快照。审计同样不动约束——`workflow_operation_audit_logs.action` 的 CHECK 只允许 8 个既有值，故归档记为 `workflow-updated` + `metadata.archived`。用 `?: true` 而非 `boolean`：恢复删键，避免 `archived: false` 噪音沉进每一份版本快照。
- **权衡（重要）**：标记在 jsonb 里，SQL 不能直接 `WHERE archived` 排除，仍要「取全量行 → 解析 payload → JS 过滤」。也就是说**归档省下的是 GitHub 调用，不是 35 行的解析成本**。现状代码本来就是这个形状，35 行规模下这个代价可忽略；若流程数涨到几百，再单独提一列并回填。
- **排除只落在一个咽喉点**：`reconcileWorkflowStages` 的 `tracked` flatMap 一处同时覆盖 cron 与全部 realtime 触发。另外 `projectPullRequestWebhook` 也跳过归档流程——否则它仍在写 `workflow_stage_states`，留下再也不会被校准刷新的脏数据。`listWorkflows` 照旧返回全部，前端靠它渲染归档视图。
- **归档即停**：保存事务之后把该流程 `queued` / `paused` 的动作标 `cancelled`（原因写「流程已归档」），`running` 的让它跑完（正卡在 GitHub 调用上，取消会丢结果）；同时清掉 `reconcile_pending_since`，否则归档流程会一直排在实时补齐的队首。**恢复**则相反，置上 `reconcile_pending_since`，让下一次触发优先接手——它可能已经错过几小时的事件。
- **排空是竞态兜底**：归档前就已启动的那次校准可能在归档之后才把动作插进来，所以 drain 查询多读一列 `payload->>'archived'`（走已有的 LEFT JOIN，不多一次查询），并把归档判定放在所有分支之前——其余分支都可能以 `skip` 收尾，而没有任何机制会回头看被 skip 的行。
- 界面：看板与四个计数一律只算 active，归档流程收在第五个筛选按钮后面，只提供「恢复」（不提供编辑与查看详情，避免对一个已退出校准范围的流程重新开工）。权限用 `workflow-edit` 而非 `workflow-delete`：归档可逆。
- **生产验收已完成（2026-08-17，`bayernjf/pr-helper-e2e-sandbox` 的 `E2E Failure and Dynamic Rule`），三步全过**：
  - 归档：`archived=true`；`queued` 的动作 237 与 `paused` 的动作 203 同时变 `cancelled` 且原因为「流程已归档，自动化动作不再执行」；`reconcile_pending_since` 清空；审计 `workflow-updated` / `metadata = {version: 66, archived: true}`。上一条版本 65 的 metadata 里**没有** `archived` 键，从版本快照侧印证了「删键而非设 false」。
  - 归档期间：推匹配 `fix/*` 的新分支后，零新动作、stage 状态一行未动、PR 未建；被推的正是它的分支，webhook run 4985 与 cron run 4986 的 `claimed_workflow_ids` 里仍没有它。
  - 恢复：`payload ? 'archived'` 为 false（键真删）；`reconcile_pending_since` 写入后 2 秒即被 run 4987 认领；归档期间漏掉的分支补出 stage 状态并新排动作 238，重试一次后 `succeeded`、建出 PR #15；动作 237 / 203 保持 `cancelled` 未复活。
  - 顺带确认两点行为正确：动作吃到 GitHub 超时后自行 `paused` → 重试 → `succeeded`，`attempts` 未被多记；认领它的 sweep 若是 `degraded` 则不清 `reconcile_pending_since`，等成功那轮才清（degraded 不该被当成已追平）。
  - 造场景用的分支与 PR（`fix/archive-acceptance` / #14、`fix/archive-while-archived` / #15）**有意保留**在沙箱，供后续 E2E 复用。
- **不归档 `*-landing`**：这些流程仍在维护，用户明确要保留在校准范围内。因此「归档存量流程以量化调用量下降」这条不做；调用预算仍按第二节的阈值观察推进。

## 2026-08-12 刷新链路最新结论

- 详情页、步骤抽屉及创建/合并/重试/回滚/删除后的刷新按当前仓库触发；流程总览手动“刷新队列”和定时 reconciliation 仍为全量。
- 手动 reconciliation 已改为后台执行，接口先返回已持久化快照，不再等待 GitHub 全量请求完成。
- 浏览器侧 GitHub API 请求统一设置 20 秒超时；超时后刷新控件恢复可操作并显示错误。
- Production 私有流程 `bayernjf/pr-helper-e2e-sandbox-private` 的 PR #1 门禁显示 `1/1 已通过`；后台同步最近实测约 26 秒。
- 下一步：验证详情刷新和抽屉同步的成功/超时终态，并通过 Vercel 日志定位后台 reconciliation 的具体慢请求。

## 已部署修复

以下修复已部署 Production 并完成回归：

- 待办请求串行器：合并并发后台快照，手动 reconciliation 在快照结束后只执行一次；失败或超时保留最后一个有效的阶段快照。新增 `src/lib/action-queue-request-queue.test.ts`。

对应提交：`c458da48 fix(inbox): serialize concurrent refreshes`。

Production 已验证行为：

1. 快速连续保存同一流程的 `409` 已在 Production 连续新增/删除与整页刷新中通过复验。
2. 动态 PR #4、失败恢复入口和产品内 Actions 重跑/冷却已通过；重跑后重新同步的并发状态也已通过复验，抽屉不会丢失 PR 状态。
3. 单次 `GET /api/inbox?refresh=1` 已在 Production 约 37–41 秒完成；未再复现 300 秒 `504`。

## 部署与会话边界

| 入口 | 实际职责 | 登录后行为 |
| --- | --- | --- |
| `https://pr-helper-ten.vercel.app` | Canonical 应用和安全 API | GitHub OAuth session Cookie 由此域签发；所有已登录读写均在此域完成。 |
| `https://pr-helper.pages.dev` | Cloudflare Pages 静态入口/镜像 | GitHub 授权完成后会跳转到 Vercel canonical 应用。 |

当前 Cookie 使用 `SameSite=Lax`，且浏览器请求未启用跨域凭据/CORS。因此 Cloudflare Pages 不是保持 GitHub 登录态并写入流程数据的前端。

### CSRF 结论

- 真实写操作的来源是 Vercel，已由 `APP_ORIGIN` 覆盖。
- `CSRF_ALLOWED_ORIGINS` 当前包含 Cloudflare Pages，但在上述会话模型下不会参与已登录写请求；保留该变量不影响功能，也不能作为 Cloudflare 写操作的验收依据。
- Cloudflare 的正确验收是：连接 GitHub 后能正常跳转到 Vercel。
- Vercel 的正确验收是：保存流程、步骤排序、创建 PR、同步和恢复操作正常完成，且没有 403 或“请求来源校验失败”。
- 若未来要让用户授权后返回 Cloudflare 并持续操作，必须单独设计跨站 Cookie、`SameSite=None; Secure`、CORS 凭据、回跳白名单和 CSRF 防护；未经专项安全设计不得直接改动。

## 本批次已交付

### Lane 自定义排序动画（2026-08-08）

- 拖动中的 Lane 使用轻微抬升、阴影和降低透明度，避免拖动源与目标混淆。
- 拖动经过其他 Lane 时，被跨越的 Lane 会以平滑位移让出空间，同时显示细线放置提示。
- 松手后使用前后布局位置差执行平滑归位动画；系统启用"减少动态效果"时自动跳过动画。
- 修复原生拖拽预览图：HTML5 默认用抓取手柄（30×42px 按钮）作为预览图，导致整个卡片不可见。改为使用整个 Lane 卡片作为拖拽预览图，鼠标跟随完整卡片而非小手柄。draft step 拖拽同样修复。
- 仅影响看板视觉反馈，不改变自定义排序、创建时间/流程名称排序、持久化和权限逻辑。

相关本地提交：`129db809`、`7483a649`、`795823c4`、`b8761c01`。

- 阶段稳定身份：`stage_id`、迁移 `018`/`019`、流程排序后状态不再按数组位置错配。
- 流程版本并发控制、创建 PR 重复检查、Actions 重跑/回滚幂等事件键、请求来源校验和用户级限流。
- 服务端统一阶段决策模型：`locked`、`waiting`、`checks-failed`、`needs-approval`、`ready-to-merge`、`ready-to-create`、`merged`。
- 同步健康度、运行历史、时间线、失败处理中心、流程预检、恢复策略和加密云同步原型。
- 合规基础：隐私政策、账户删除端点、GitHub 权限说明。

相关本地提交：

1. `e0be237d feat(storage): add workflow telemetry and stable stage identity`
2. `d8bba359 feat(api): add request protection and recovery endpoints`
3. `d2fa5d76 feat(ui): add workflow recovery and sync experiences`
4. `2b9be383 docs: align architecture and release checklist`
5. `b4b2c9fb test: add coverage tooling`
6. `40b45cf9 docs: remove trailing whitespace`

## 剩余生产验收

以下为唯一的外部条件待办。它们并非未实现，而是尚无足以产生真实验收证据的账户、仓库或部署环境：

| 待办 | 你需要准备 | Codex 负责 | 验收结论 |
| --- | --- | --- | --- |
| Required approval | 第二个可审批 GitHub 账号；E2E 目标分支要求 1 个审批 | 创建测试 PR，验证并记录状态迁移 | `needs-approval` → `ready-to-merge` |
| Vercel / Cloudflare 部署与回滚 | 低风险仓库、真实工作流/Environment/密钥、健康检查地址、单独回滚窗口 | 触发、跟踪并记录双平台部署、失败和确认式回滚 | 双平台门禁、健康检查和确认式 Production 回滚可追溯 |
| GitHub Webhook 自动投影 | 保持 Production 页面打开并准备可触发事件 | 触发事件，核查 delivery、投影和无刷新 UI 更新 | 无手动刷新时自动更新看板和时间线 |
| private / organization 安装边界 | 已授权 private 仓库和 organization 仓库，配置 GitHub App 仓库选择范围 | 验证授权内读写和授权外拒绝 | 授权范围正确生效，范围外访问被拒绝 |

你完成准备后仅需通知对应验收项已就绪；其余测试操作、证据整理和验证报告更新由 Codex 执行。加密云同步和数据保留清理无需额外准备，待测试数据或生产 Cron 可观察时由 Codex 回归。

不要为了验收立即触发 Production 回滚；该操作会真实改变线上版本，应仅在单独安排的低风险窗口执行。

## 后续高价值投入

### PR 流程自动化（已部署生产，自动创建与自动合并均已验收）

自动化方案已确认，详见 [`docs/automated-workflow-plan.md`](docs/automated-workflow-plan.md)。服务端加密 AI 凭据、`024`–`031`、步骤规则快照、幂等动作队列和 Webhook/`pg_cron`/inbox 后台触发均已部署生产；第一阶段不做画布。自动创建 PR 只有在服务端自动流程凭据可用、AI 设置中的“自动生成标题和描述”“自动确认创建”均开启，且存在有效生成规则快照时才允许用户启用；条件满足不会自动勾选，必须用户主动点击，默认规则优先。默认关闭自动合并、自动推进和生产高风险动作。

当前浏览器 AI Key 位于 `sessionStorage`，同一标签页刷新后仍存在；限制是后端无法读取，而不是刷新即丢失。它继续用于手动流程且不会自动上传。自动流程使用用户单独保存的服务端加密凭据；现有口令派生的加密云同步因服务端无法解密，不能复用。AI 生成标题/描述失败时自动动作暂停并保留脱敏原因；用户可重新生成或手动填写内容，明确确认后 Unpause 继续原动作，不采用未经确认的兜底文案，也不做无人值守代码修改、推送或生产合并。

当前本地已落地自动流程 AI 凭据、步骤级自动创建策略配置和规则快照、`025_workflow_automation_queue.sql` 对应的运行快照和幂等动作队列、`026_ai_automation_preferences.sql` 对应的服务端偏好，以及 webhook / cron / inbox reconciliation 的后台自动触发。`024`、`025`、`026` 已执行，Vercel Production/Preview 已配置 `AI_CREDENTIALS_ENCRYPTION_KEY`，代码已部署生产。本次执行器以稳定幂等键和 `queued → running` 原子领取防止重复创建，失败动作会暂停；AI 生成失败时用户可接管并确认后 Unpause 继续原动作；不自动合并。

后续自动化 UI 需要在流程详情增加步骤级进度条：展示上一步、当前步骤、下一步、门禁等待、暂停原因和可执行操作。进度必须由服务端统一阶段决策与动作队列投影，不能只根据浏览器刷新结果计算；多路径汇聚只有所有前置路径成功后才解锁。

2026-08-19：只读进度条已实现（本地提交 `a18e1ad9`、`30c1b90c`、`34a7a536`、`6ab15776`、`aa28fe1d`、`c06d7342`）。形态是流程详情时间线顶部一条整体进度条，每个步骤一个节点，状态由 `stageProgressNode` 从服务端 `decision` 与动作队列共同推出：动作 `failed` 或门禁红 → 失败；动作 `paused` → 已暂停；`queued`/`running` 且带 `failure_reason` → 等待门禁（服务端把门禁等待写在仍为 `queued` 的行上），无原因 → 进行中；`merged` → 已完成；通配步骤取所有分支中最严重的一个，避免一条成功的分支盖住另一条失败的。节点点击复用既有步骤抽屉，不显示百分比。所有投影都未到时显示「等待状态同步」而不是一排空节点。

写入路径（「接管 AI 内容」弹窗、Unpause、重新生成）继续后置，依据是生产数据：`create-pr` 共 117 次成功、4 次取消、2 次 `paused`，两条 `paused` 的原因都是「当前步骤尚未满足自动创建 PR 的门禁」而非 AI 生成失败；`workflow_operation_audit_logs` 至今没有任何一次 AI 生成失败；且 `paused` 不是终态，120 秒 stale 逻辑会把它重排回 `queued`。也就是说该弹窗目前没有真实要覆盖的失败模式，等出现第一例再做。

AI 失败节点的交互已明确：进度条位于每个步骤“自动创建 PR”控件下方；点击 `paused` 节点打开接管弹窗，用户可重新生成或手动填写 PR 标题/描述，点击“确认并继续自动流程”后复用原动作 ID 恢复。内容确认不直接放行，必须等 PR 创建和全部 GitHub 门禁、合并后 Checks/Actions、部署及健康检查完成后节点才变绿并激活下一步。

当前生产诊断结论：GitHub App 已勾选 Push，GitHub Actions 的 `PR_HELPER_CRON_SECRET` 已与 Vercel Production 重新同步。2026-08-13 的生产库查询已定位自动创建 PR 不工作的完整原因链，并确认与凭据、偏好和规则快照配置无关：动作能入队但从未被领取（`queued` / `attempts=0` / `failure_reason=null`），根因是 `BIGSERIAL` 身份被 postgres.js 返回为字符串后未归一化，以及一处空 `catch` 吞掉了失败；cron 校准实际是跑完的（`51/51` 阶段，约 160 秒），Actions 报红只是 `curl --max-time 30` 提前放弃，`--retry 2` 还派生了重叠的全量 sweep。另外 `deriveStageDecision` 用单个枚举同时承担展示状态和可执行性，导致「已合并 + 全绿 + 有新提交」永远无法进入自动创建门禁。

诉求、问题清单、修复方案、修复后影响和回归测试清单见 [`docs/auto-create-pr-remediation.md`](docs/auto-create-pr-remediation.md)。已确认的需求决策：合并后门禁为红时不自动向下游创建 PR。`P1`–`P6` 已全部提交并合入 `main`、生产已部署，`P3`（cron 分批 + curl 超时）生产验收通过。

生产验收查出仍未修的真正根因 `P8`：`workflow_automation_actions` 表没有 `stage_index` 列（`025` 只把它建在 `workflow_automation_runs` 上），而执行器 `executeWorkflowAutomationActionForUser` 和队列列表 `listWorkflowAutomationActions` 都在 SELECT 它。执行器在原子领取动作**之前**就抛 `column "stage_index" does not exist`，所以动作永远停在 `queued` / `attempts=0`——这是自动创建至今从未成功过的原因。修法是把两条查询改为 JOIN `workflow_automation_runs` 取该列，不需要迁移；配套加一条「迁移列集合 ⊇ SELECT 列名」的静态一致性守卫测试。P1/P2 的价值在于让这条错误第一次被写进 `failure_reason` 而不是继续静默。

`P8` 已按上述修法落代码并由用户部署到生产，验证生效：动作首次被真正领取，`attempts` 由 0 变 1。随即暴露 `P9`——`generateAutomationMessage` 的围栏剥离把 `trim()` 写在 `replace()` 之后，模型只要在 ```` ```json ```` 前多一个换行，`^` 锚点就失配，围栏原样进 `JSON.parse`，动作落到 `paused` / `attempts=1`。已抽出可单测的 `jsonFromModelText`（先 trim、再判断是否以围栏开头、从末尾找收尾围栏以免误截 PR 正文里的代码块），`P9` 已部署生产并完成验收：`2026-08-14 00:20:08` 自动建出 `bayernjf/bayjf#42`（`feature/20260719 → dev`，作者 `app/pr-helper-by-bayernjf`），动作 3 为 `succeeded` / `attempts=2` / `payload.pullNumber=42`，审计里 `metadata.via='workflow-automation'` 只有一条，后续轮转未重复建。**服务端自动创建 PR 至此在生产端到端跑通。** 仍未验的两项：门禁为红不触发、幂等命中记成功——生产数据里没有对应场景，需另造。遗留：动作 1、2 因 `headSha` 过期永远停在 `queued`，已决定保留作为排障痕迹（见 remediation 文档第九节）。

第 5 阶段「逐步骤自动合并」已于 2026-08-14 落地并于 2026-08-15 在生产验证通过，设计见 [`docs/automated-workflow-plan.md`](docs/automated-workflow-plan.md)。要点：与自动创建**状态独立**的按步骤开关（互不清除，可只开自动合并），但界面可勾选条件与自动创建**对齐**——同样要求四项 AI 前置，另加 `pull-merge` 权限；该约束只在界面，服务端 `enqueueServerAutoMerge` 不校验 AI 前置；只做 merge commit，请求必带 `sha = pull.head.sha`；只在 `mergeable=true` 且 `mergeable_state='clean'` 时合并，`'behind'` 只暂停不自动 update branch；失败次数达 `recoveryPolicy.maxRetries` 后停在 `paused` 不再被 120 秒 stale 逻辑重排；PR 已 merged 记 `succeeded` 幂等成功。注意「合并后 Actions 全绿才解锁下一步」已经实现（`stageIsUnlocked` + `mergeChecksWithDeployments`），不在本阶段范围；合并后自动推进属第 6 阶段。

在上述生产验收通过后，建议顺序为：

1. 瞬时失败的重排路径已实现，等一次真实的瞬时故障做生产验证（当前第一优先级）。reconciliation 的调用预算**不在**这个位置：按小时复核后只占基线的 18%–34%，已改为阈值观察，见上方第二节。
2. 后台自动创建 PR 与自动合并：生产已跑通；门禁为红与幂等命中两项均已在沙箱验完（前者顺带修掉 ruleset 审批不可见），自动化验收清单无未验项。
3. 浏览器 E2E：已覆盖授权返回、新建/编辑流程、步骤排序、失败恢复、抽屉创建/合并 PR、删除流程和确认式回滚；Webhook 自动投影已有真实 delivery 证据。
4. 操作审计：`020` 已执行；Production 已完成流程更新、创建/合并 PR 记录读取及 CSV 导出可用性验收。✅
5. 加密云同步加固：已部署，`021` 已执行；待验证 v1/v2 兼容、口令轮换、冲突拒绝和历史恢复。
6. 历史数据保留与清理：已部署，`022` 已执行；待确认 Cron 产生成功运行记录并按批次清理历史数据。
7. 团队协作闭环：已部署团队管理界面、成员角色管理、流程共享、共享状态投影和服务端操作授权；`023` 已执行。需用至少两个 GitHub 账号验收角色边界与 GitHub App 安装范围。

不建议第一阶段投入任意 DAG、流程模板市场、自建 CI/CD 引擎或无额外安全设计的 AI 自动修复。画布仅在条件分支、并行节点、汇聚节点和回滚路径的可视化需求明确后再投入。

## 常用命令

```bash
npm test
npm run test:e2e
npx tsc --noEmit
npm run lint
npm run dev
```

不要编辑或提交 `node_modules/`、`dist/`，不要把 GitHub/Vercel/Supabase 密钥写入仓库。
