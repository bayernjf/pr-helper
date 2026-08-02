# PR Helper 验证报告

> 执行日期：2026-08-03（Asia/Shanghai）  
> 范围：本地代码、Vercel Production、GitHub App 与公开 E2E 沙箱。  
> 原则：只有可复现且有证据的结果标记为通过；本地修复未部署前不计入 Production 通过。
> 后续状态：`021`–`023` 对应代码已在本报告之后部署 Production，但尚未纳入本报告的多账号团队协作、加密同步或保留清理验收。

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

### P1：操作审计读取复用了动态路由参数

Production 已加载操作审计界面且一次“保存恢复策略”成功返回，但审计列表显示为空。根因是前端请求 `/api/inbox?action=operation-audit`，而动态路由 `api/[action].ts` 已把路径段 `inbox` 绑定为同名参数；服务端因此返回待办队列，而前端将缺失的 `entries` 解释为空列表。

本地已改为 `GET /api/inbox?resource=operation-audit&limit=200`，保留现有 Serverless Function 数量，并先让原路径的浏览器回归失败、再验证新路由通过。修复已部署；Production 已显示既有“更新流程”记录以及创建/合并 PR 记录，CSV 导出按钮已启用，问题已关闭。

### 未取得通过证据的集成项

| 项目 | 当前状态 | 原因 |
| --- | --- | --- |
| GitHub Webhook 自动投影 | 待验证 | 未取得 webhook delivery 与数据库投影的对应证据；手动刷新不等于 webhook 通过 |
| 审批门禁 | 待验证 | 需要第二个可审批账户；单账号无法审批自己的 PR |
| Vercel / Cloudflare 部署门禁、健康检查、确认式回滚 | 待验证 | E2E 沙箱未配置真实部署工作流和 Environment |
| Web Push（关闭页面投递） | 待验证 | 需 VAPID、订阅、Service Worker 与关闭页面场景 |
| private / organization 仓库授权边界 | 待验证 | 本轮只使用公开仓库 |

### 外部条件待办

下列验收不能通过模拟数据或手动刷新完成，保留为项目待办，直到真实条件可用：

| 待办 | 外部条件 | 验收证据 |
| --- | --- | --- |
| Required approval | 第二个可审批 GitHub 账号与至少 1 个 required approval | `needs-approval` 在有效审批后迁移为 `ready-to-merge` |
| Vercel / Cloudflare 部署与回滚 | 低风险仓库的实际工作流、Environment 和部署密钥 | 双平台门禁、健康检查、失败追踪及确认式 Production 回滚 |
| Webhook 自动投影 | GitHub delivery 与服务端数据库投影的对应证据 | 无手动刷新时 Lane、抽屉和时间线自动更新 |
| private / organization 边界 | 已授权 private 和 organization 测试仓库 | 授权范围内成功操作，范围外仓库不可访问 |

## 建议的复验顺序

1. 满足「外部条件待办」的条件后，按表中顺序完成四项验收；Production 回滚仅在单独低风险窗口执行。

## 沙箱保留状态

- #1、#2、#3 已合并，保留作为成功链路审计证据。
- #4 故意保持打开且失败，用于后续动态规则、失败恢复和重跑复验。
- Production 中保留 `PR Helper E2E Sandbox`、`E2E Failure and Dynamic Rule` 与 `E2E Persistence Regression` 三个测试流程，便于部署后复验；未经确认不删除。
