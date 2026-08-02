# PR Helper 验证报告

> 执行日期：2026-08-03（Asia/Shanghai）  
> 范围：本地代码、Vercel Production、GitHub App 与公开 E2E 沙箱。  
> 原则：只有可复现且有证据的结果标记为通过；本地修复未部署前不计入 Production 通过。

## 环境与测试资源

- Production：`https://pr-helper-ten.vercel.app/?github=connected`
- 公开测试仓库：[bayernjf/pr-helper-e2e-sandbox](https://github.com/bayernjf/pr-helper-e2e-sandbox)
- GitHub App 已被授权访问该仓库。
- 受保护分支：`dev`、`main`；二者均要求 `PR gate` 成功且启用 strict update。
- 沙箱 Actions：PR 门禁 `PR gate`，合并后验证 `Post-merge verification`。

## 通过的验证

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| 本地单元测试 | `npm test` | 21 个测试文件、168 项测试全部通过 |
| 类型检查 | `npx tsc --noEmit` | 通过 |
| 浏览器生产构建 | `npm run lint`（Vite production build） | 通过 |
| 变更格式 | `git diff --check` | 通过 |
| GitHub App 授权与仓库读取 | Production 可列出 E2E 沙箱并创建流程 | 通过 |
| 流程单次云端保存 | Production 创建 `E2E Persistence Regression`，切回总览后整页刷新仍存在 | 通过 |
| 创建 PR、PR Actions、应用内合并 | [PR #1](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/1) `feature/test → dev` | 通过 |
| strict 分支保护 | [PR #2](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/2) 初始因 `dev` 前进被阻塞；更新分支后才可在应用内合并 | 通过 |
| AI PR 标题/描述生成与应用内创建 PR | [PR #2](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/2) | 通过（未逐 token 截图） |
| 多路径汇聚 | [PR #3](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/3) `dev → main` 仅在 #1、#2 合并并完成合并后检查后解锁 | 通过 |
| 合并后 Actions 跟踪 | #1、#2、#3 合并后的 `Post-merge verification` 成功，界面显示“合并后验证通过” | 通过 |
| 失败门禁的 GitHub 原生状态 | [PR #4](https://github.com/bayernjf/pr-helper-e2e-sandbox/pull/4) 为开放状态，`PR gate=FAILURE`，`mergeStateStatus=BLOCKED` | 通过 |

## 发现的问题与结论

### P0：连续保存会触发流程版本自冲突

Production 编辑器的每次变更都会并发发送 `PUT /api/workflows`。多个请求带着同一个版本号到达服务端后，乐观锁会正确拒绝后续请求并返回 `409`，页面显示“云端流程同步失败”。这不是 GitHub App 或数据库随机故障。

已在本地加入按 `workflow.id` 串行且合并连续修改的保存队列，并新增 2 项回归测试：

- 第一次保存返回新版本后，后续保存携带该新版本；
- 本地最新编辑内容不被旧响应覆盖；
- 真正的跨窗口乐观锁冲突仍停止并明确提示，绝不自动覆盖远端数据。

此修复尚未部署，故其 Production 状态为 **待复验**。

### P1：动态来源规则在详情即时刷新中不可观测

服务端 reconciliation 能枚举 `fix/*` 命中的仓库分支，但详情页的即时刷新对任意包含 `*` 的 Source 直接返回“未创建”，不会请求 GitHub。Production 中的 `E2E Failure and Dynamic Rule` 流程因此没有显示 `fix/failure-e2e → dev` 的 #4 失败状态。

这意味着：GitHub 门禁失败已得到验证，但“动态规则 → 产品界面失败状态 → Codex 修复 / Actions 重试”的闭环 **尚未通过 Production 验收**。本地已改为：详情页按服务端投影逐条展示实际匹配分支，并在手动刷新时触发一次服务端校准；每条状态可打开原有抽屉执行修复或重跑。该改动仍待部署后以 #4 复验。

### P1：待办队列生产刷新曾超时

此前 Production 的 `GET /api/inbox?refresh=1` 在 Vercel 超过 300 秒并返回 `504`。本地已加入 GitHub installation token 缓存、15 秒 GitHub API 超时和前端 60 秒超时提示；这些变更尚未部署，不能标记为线上通过。

### 未取得通过证据的集成项

| 项目 | 当前状态 | 原因 |
| --- | --- | --- |
| GitHub Webhook 自动投影 | 待验证 | 未取得 webhook delivery 与数据库投影的对应证据；手动刷新不等于 webhook 通过 |
| 失败 Actions 的产品内重跑、Codex 修复包 | 待验证 | 动态 #4 尚未进入产品状态投影 |
| 审批门禁 | 待验证 | 需要第二个可审批账户；单账号无法审批自己的 PR |
| Vercel / Cloudflare 部署门禁、健康检查、确认式回滚 | 待验证 | E2E 沙箱未配置真实部署工作流和 Environment |
| Web Push（关闭页面投递） | 待验证 | 需 VAPID、订阅、Service Worker 与关闭页面场景 |
| private / organization 仓库授权边界 | 待验证 | 本轮只使用公开仓库 |

## 建议的复验顺序

1. 部署当前本地修复后，在 Production 连续添加/删除步骤、部署门禁和恢复策略，确认无 `409` 且刷新后流程完整保留。
2. 点击“刷新队列”，确认在 60 秒内得到成功或清晰的超时结果，不能再由 Vercel 运行到 300 秒超时。
3. 对 PR #4 验证动态 `fix/*` 流程显示 Actions 失败、禁止合并、生成 Codex 修复包，并在冷却策略内测试一次 Actions 重跑。
4. 用第二个账户配置至少 1 个 required approval，验证 `needs-approval` 到 `ready-to-merge` 的状态迁移。
5. 单独安排低风险窗口，配置真实 Vercel/Cloudflare 部署后验证部署门禁、健康检查与确认式回滚；不要把 Production 回滚作为常规回归测试。

## 沙箱保留状态

- #1、#2、#3 已合并，保留作为成功链路审计证据。
- #4 故意保持打开且失败，用于后续动态规则、失败恢复和重跑复验。
- Production 中保留 `PR Helper E2E Sandbox`、`E2E Failure and Dynamic Rule` 与 `E2E Persistence Regression` 三个测试流程，便于部署后复验；未经确认不删除。
