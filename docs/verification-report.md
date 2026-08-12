# PR Helper 验证报告

> 执行日期：2026-08-12（Asia/Shanghai）
> 范围：本地代码、Vercel Production、GitHub App 与公开 E2E 沙箱。  
> 原则：只有可复现且有证据的结果标记为通过；本地修复未部署前不计入 Production 通过。
> 后续状态：`021`–`023` 对应代码已在本报告之后部署 Production，但尚未纳入本报告的多账号团队协作、加密同步或保留清理验收。

## 2026-08-12 Production 追加验收

本节补充 2026-08-11 至 2026-08-12 在同一 Production 与 E2E 沙箱完成的真实验证；不替代本报告中仍列为待验证的回滚、private / organization、Web Push 与多账号协作项目。

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| Required approval 流程 | PR #5 `feature/approval-e2e → dev` 在第二 GitHub 账号审批后成为可合并状态，并由应用内完成合并 | 通过 |
| Preview 部署跟踪 | PR #7 `feature/deployment-e2e → dev` 合并后，Vercel 与 Cloudflare Pages Preview Actions 均成功，抽屉显示部署记录 | 通过 |
| 合并门禁 | PR #8 `dev → main` 在 `3/4 Actions` 进行中时不显示合并按钮；全部通过后显示合并入口 | 通过 |
| Production 部署跟踪 | PR #8 合并后，Vercel、Cloudflare Pages 与 Post-merge verification 三项 main 分支 Actions 均成功；页面显示两项 Production 部署成功 | 通过 |
| 发布运行状态 | 合并后终态已将 PR #8 的运行记录从“发布运行中”更新为“发布完成” | 通过 |
| 同步超时保护 | 真实全量 reconciliation 约 150 秒；前端等待阈值调整为 180 秒后成功完成并保留同步结果 | 通过 |
| GitHub Webhook 自动投影 | GitHub App 订阅 PR、Checks、Status 与 Workflow 事件；沙箱 PR #11 的 `pull_request.reopened` delivery 返回 `202`（2.73 秒），Production 详情页不点击刷新，在下一个轮询周期自动新增 `feature/webhook-live-e2e-2 · PR #11` | 通过 |

本轮本地回归：`npm test` 24 个测试文件 / 205 个测试通过，`npx tsc --noEmit`、`npm run lint` 与 `git diff --check` 通过。

PR #172 的初始 Vercel Preview 失败并非 Vercel 服务故障：第一次是 Serverless TypeScript 编译暴露了 `api/` 未被本地 `tsconfig.json` 覆盖的类型错误；第二次是 Hobby 计划的 Serverless Function 数量限制。已将 `api/` 纳入 TypeScript 检查、修复类型错误，并将两个自动化入口合并到 `/api/workflows` rewrite。提交 `93c00d41` 后 Vercel Preview、CI 和 Preview Comments 全部通过。

## 2026-08-12 刷新链路优化追加验收

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| 私有仓库流程读取 | `bayernjf/pr-helper-e2e-sandbox-private` 的 PR #1 显示 `1/1 已通过` | 通过 |
| 后台 reconciliation | Production 看板显示“已同步 1 个步骤”，最近一次耗时约 `26067ms` | 通过；后台执行不阻塞看板 |
| 手动刷新保护 | 详情刷新不再无限等待；浏览器 GitHub 请求已设置 20 秒超时 | 已部署，需继续观察成功/超时两种终态 |
| 当前仓库范围 | 详情、抽屉及流程操作后请求携带仓库范围；总览刷新和 Cron 仍为全量 | 代码已验证，待日志确认生产请求参数 |

本轮本地回归：`npm test` 23 个测试文件 / 198 个测试通过，`npx tsc --noEmit` 与 `npm run lint` 通过。

## 环境与测试资源

- Production：`https://pr-helper-ten.vercel.app/?github=connected`
- 公开测试仓库：[bayernjf/pr-helper-e2e-sandbox](https://github.com/bayernjf/pr-helper-e2e-sandbox)
- GitHub App 已被授权访问该仓库。
- 受保护分支：`dev`、`main`；二者均要求 `PR gate` 成功且启用 strict update。
- 沙箱 Actions：PR 门禁 `PR gate`，合并后验证 `Post-merge verification`。

## 通过的验证

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| 本地单元测试 | `npm test` | 22 个测试文件、172 项测试全部通过 |
| 本地浏览器回归 | `npm run test:e2e` | Playwright Chromium 9 项：授权返回、流程创建与刷新恢复、步骤排序、失败重跑、抽屉创建/合并 PR、流程删除、确认式部署回滚、操作审计查询 | 通过（API mock） |
| 类型检查 | `npx tsc --noEmit` | 通过 |
| 浏览器生产构建 | `npm run lint`（Vite production build） | 通过 |
| 变更格式 | `git diff --check` | 通过 |
| 审计日志数据库迁移 | 用户已执行 `020_operation_audit_logs.sql` | 通过 |
| 操作审计 Production 读写 | 账户菜单显示真实的流程更新、创建 PR、合并 PR 记录 | 通过；CSV 导出按钮已启用 |
| GitHub App 授权与仓库读取 | Production 可列出 E2E 沙箱并创建流程 | 通过 |
| 流程单次云端保存 | Production 创建 `E2E Persistence Regression`，切回总览后整页刷新仍存在 | 通过 |
| 创建 PR、PR Actions、应用内合并 | [PR #1](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/1) `feature/test → dev` | 通过 |
| strict 分支保护 | [PR #2](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/2) 初始因 `dev` 前进被阻塞；更新分支后才可在应用内合并 | 通过 |
| AI PR 标题/描述生成与应用内创建 PR | [PR #2](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/2) | 通过（未逐 token 截图） |
| 多路径汇聚 | [PR #3](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/3) `dev → main` 仅在 #1、#2 合并并完成合并后检查后解锁 | 通过 |
| 合并后 Actions 跟踪 | #1、#2、#3 合并后的 `Post-merge verification` 成功，界面显示“合并后验证通过” | 通过 |
| 失败门禁的 GitHub 原生状态 | [PR #4](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/4) 为开放状态，`PR gate=FAILURE`，`mergeStateStatus=BLOCKED` | 通过 |
| 动态来源投影与失败中心 | Production 的 `fix/* → dev` 已列出 `fix/failure-e2e`，失败处理中心显示 PR #4 并提供修复、重跑入口 | 通过 |
| 队列手动刷新 | Production 点击“刷新队列”后在 41.236 秒内完成，15 个阶段投影由旧快照更新为当前状态 | 通过 |
| 动态步骤抽屉 | `fix/failure-e2e → dev` 抽屉显示 PR #4、`0/1` 门禁和“第 1 步 Actions 失败” | 通过 |
| 产品内 Actions 重跑与冷却 | 从抽屉重跑 PR #4；GitHub Checks 显示 `PR gate` 第 2 次运行，产品随后的队列快照显示“冷却中”并禁用重跑按钮 | 通过 |
| 并发刷新后的抽屉状态 | 部署请求串行修复后，从动态抽屉重新同步耗时 37.474 秒；抽屉刷新后仍保留 PR #4、`0/1` 门禁和 Actions 失败状态 | 通过 |
| 连续流程保存 | 在 `E2E Persistence Regression` 连续新增再删除合并路径，整页刷新后远端仅保留原 `feature/test → dev` 步骤，未出现 `409` | 通过 |
| Codex 修复包边界 | PR #4 生成包仅包含诊断文本、GitHub 链接和本地修复要求，明确禁止 push、创建 PR 与合并 | 通过 |

## 发现的问题与结论

### 浏览器 E2E 边界

新增的 Playwright 用例启动本地 Vite，并在浏览器网络层 mock GitHub App / 工作流 / 队列 API。它验证真实 DOM、事件绑定、表单、抽屉、二次确认和请求负载，适合防止前端交互回归；不使用 GitHub token、不创建或合并真实 PR，也不能替代下方需要真实第三方状态的验收项目。

### P0：连续保存会触发流程版本自冲突

Production 编辑器的每次变更都会并发发送 `PUT /api/workflows`。多个请求带着同一个版本号到达服务端后，乐观锁会正确拒绝后续请求并返回 `409`，页面显示“云端流程同步失败”。这不是 GitHub App 或数据库随机故障。

已上线按 `workflow.id` 串行且合并连续修改的保存队列，并新增 2 项回归测试：

- 第一次保存返回新版本后，后续保存携带该新版本；
- 本地最新编辑内容不被旧响应覆盖；
- 真正的跨窗口乐观锁冲突仍停止并明确提示，绝不自动覆盖远端数据。

Production 已通过连续新增/删除与整页刷新复验，未再出现 `409`。

### P1：动态来源规则在详情即时刷新中不可观测

服务端 reconciliation 能枚举 `fix/*` 命中的仓库分支，但详情页的即时刷新对任意包含 `*` 的 Source 直接返回“未创建”，不会请求 GitHub。Production 中的 `E2E Failure and Dynamic Rule` 流程因此没有显示 `fix/failure-e2e → dev` 的 #4 失败状态。

动态规则到失败中心和恢复抽屉的 Production 投影已通过。详情抽屉的具体分支状态已显示该分支的 Actions 失败。

### P1：并发待办刷新曾造成抽屉读到空快照

单次 Production 手动刷新已在 41.236 秒内完成，不再复现此前 300 秒 `504`。但在失败 Actions 重跑后立刻从抽屉再次同步时，后台快照和手动 reconciliation 会并发；其中一轮超时会清空浏览器已加载的阶段状态，导致新抽屉短暂显示“当前步骤尚无 PR”，而 Lane 仍显示 PR #4 失败。

已上线请求串行器和回归测试：并发快照读取会合并，随后只执行一次 reconciliation；失败请求保留上一次可靠快照。Production 从动态抽屉重新同步耗时 37.474 秒，抽屉刷新后仍保留 PR #4 的失败状态，问题已关闭。

### P1：动态来源未投影 PR #9

`feature/webhook-auto-e2e → dev` 的 PR #9 已通过审批并合并，PR gate 和合并后 Vercel、Cloudflare Pages、Post-merge verification 三项 Actions 均成功；但完成一次全量 reconciliation 后，Lane 仍未显示该动态来源。GitHub 上的分支、PR 和目标分支均符合 `feature/* → dev`。

已补充服务端来源发现兜底：除按目标分支筛选的 PR 列表外，还读取完整 PR 列表并在服务端按目标分支过滤，再与仓库分支和已保存来源去重合并。修复部署后已在 Production 执行完整 reconciliation 复验：第 1 步出现 `feature/webhook-auto-e2e · PR #9`，抽屉显示 `3/3` 门禁通过以及 Vercel、Cloudflare Preview 部署成功，且不存在重复合并入口。此项已关闭，不改变 Webhook 验收结论。

### P1：操作审计读取复用了动态路由参数

Production 已加载操作审计界面且一次“保存恢复策略”成功返回，但审计列表显示为空。根因是前端请求 `/api/inbox?action=operation-audit`，而动态路由 `api/[action].ts` 已把路径段 `inbox` 绑定为同名参数；服务端因此返回待办队列，而前端将缺失的 `entries` 解释为空列表。

本地已改为 `GET /api/inbox?resource=operation-audit&limit=200`，保留现有 Serverless Function 数量，并先让原路径的浏览器回归失败、再验证新路由通过。修复已部署；Production 已显示既有“更新流程”记录以及创建/合并 PR 记录，CSV 导出按钮已启用，问题已关闭。

### 已关闭：GitHub Webhook 自动投影

GitHub App 的 Webhook URL、Secret、SSL verification 和 Active 状态均已配置。此前缺少事件订阅；启用 PR、Checks、Status 与 Workflow 相关事件后，真实投递暴露了服务端在响应前执行完整 reconciliation 导致 GitHub 超时的问题。

修复上线后，沙箱 PR #11 被临时关闭并重新打开以触发真实 `pull_request.reopened` 事件。GitHub Recent Deliveries 显示该 delivery 返回 `202`，耗时 2.73 秒；payload 对应 `bayernjf/pr-helper-e2e-sandbox#11`。Production 中已打开的 `PR Helper E2E Sandbox` 流程详情没有点击“刷新 GitHub 状态”，一个前端轮询周期后，动态 `feature/* → dev` 步骤自动新增 `feature/webhook-live-e2e-2 · PR #11`。此项验收通过。

### 未取得通过证据的集成项

| 项目 | 当前状态 | 原因 |
| --- | --- | --- |
| 审批门禁 | 已完成基础 E2E | PR #5 已经第二账号审批后完成应用内合并；审批前状态的完整截图证据仍可在下次复验补充 |
| Vercel / Cloudflare 部署门禁、健康检查、确认式回滚 | 部署门禁通过；其余待验证 | Preview/Production 跟踪已通过；健康检查、失败投影和确认式回滚仍需低风险窗口 |
| Web Push（关闭页面投递） | 待验证 | 需 VAPID、订阅、Service Worker 与关闭页面场景 |
| private / organization 仓库授权边界 | 待验证 | 本轮只使用公开仓库 |

### 外部条件待办

下列验收不能通过模拟数据或手动刷新完成，保留为项目待办，直到真实条件可用：

| 待办 | 你需要准备 | Codex 执行 | 验收证据 |
| --- | --- | --- | --- |
| Required approval | 第二个可审批 GitHub 账号与至少 1 个 required approval | 创建 PR、审批前后读取阶段决策 | `needs-approval` 在有效审批后迁移为 `ready-to-merge` |
| Vercel / Cloudflare 部署与回滚 | 低风险仓库的实际工作流、Environment、部署密钥、健康检查地址和回滚窗口 | 触发并追踪双平台部署、失败与确认式回滚 | 双平台门禁、健康检查、失败追踪及确认式 Production 回滚 |
| private / organization 边界 | 已授权 private 和 organization 测试仓库，并设置 GitHub App 仓库范围 | 验证授权内读写及范围外拒绝 | 授权范围内成功操作，范围外仓库不可访问 |

外部条件准备就绪后，用户只需通知对应验收项；Codex 负责测试执行、证据归档和本报告结论更新。加密同步和数据保留清理分别等待测试数据和下一次生产 Cron 的可观察窗口，无需额外账号或仓库。

## 建议的复验顺序

1. 满足「外部条件待办」的条件后，按表中顺序完成四项验收；Production 回滚仅在单独低风险窗口执行。

## 尚未进入验收的功能

2026-08-12 已确认 PR 流程自动化方案。服务端加密 AI 凭据、步骤级规则快照、动作队列和后台自动创建执行已在本地实现，但尚未部署 Production，因此不属于 Production 通过项。`024`–`026` 已执行，Vercel Production/Preview 已配置加密密钥。Webhook、Cron 与 inbox reconciliation 进入 `ready-to-create` 后会使用稳定幂等键入队，并由原子领取执行器再次验证当前决策、凭据、自动生成/确认偏好、规则快照、新提交与开放 PR；失败动作暂停。逐步骤自动合并、合并后自动推进、新提交阈值仍不属于当前实现。自动创建 PR 必须验证服务端自动流程凭据、AI 自动生成标题/描述、自动确认创建和有效生成规则四项前置条件，缺少任一项时不得启用；条件满足也不会自动勾选，必须用户主动开启。详见 [`automated-workflow-plan.md`](automated-workflow-plan.md)。

本地追加：服务端加密凭据 API、`024` 迁移和步骤级自动创建策略配置已实现，`024`–`026` 已执行且环境变量已配置；待部署后进行线上验收。

本地追加：`025` 动作队列和 `ready-to-create` 执行入口已实现；步骤策略保存时捕获默认规则快照，Webhook、Cron 与 inbox reconciliation 均可触发后台执行。执行前重新校验统一阶段决策、服务端自动生成/自动确认偏好、生成规则快照、新提交与开放 PR。`026_ai_automation_preferences.sql` 已执行。自动合并不在本阶段范围内。

## 沙箱保留状态

- #1、#2、#3 已合并，保留作为成功链路审计证据。
- #4 故意保持打开且失败，用于后续动态规则、失败恢复和重跑复验。
- Production 中保留 `PR Helper E2E Sandbox`、`E2E Failure and Dynamic Rule` 与 `E2E Persistence Regression` 三个测试流程，便于部署后复验；未经确认不删除。
