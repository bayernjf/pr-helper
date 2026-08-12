# PR Helper Handoff

> 最后更新：2026-08-12
> 当前事实来源：[`docs/current-state.md`](docs/current-state.md)。历史设计和计划不应作为当前需求或上线状态的依据。

## 当前状态

- 当前分支：`feature/20260722`。
- 用户已确认本批代码已上线 Production。
- 2026-08-03 验证报告见 [`docs/verification-report.md`](docs/verification-report.md)：真实 E2E 已通过 GitHub App 授权、PR 创建、严格门禁、应用内合并、合并后 Actions 与多路径汇聚；未通过项均已明确标注。
- 当前本地验证已通过：`npm test`（24 个文件 / 205 项）、`npx tsc --noEmit`、`npm run lint`、`git diff --check`。后台自动创建 PR 代码未改变现有手动流程行为；浏览器 E2E 仍保持既有 API mock 覆盖范围。
- Supabase 迁移 `001`–`026` 已执行；`021`–`023` 对应代码已部署 Production，待加密同步线上回归、Cron 清理观察和团队多账号验收。操作审计读取已改为现有 `inbox` 函数的 `resource=operation-audit` 分流，未增加 Serverless Function 数量；Production 已显示流程更新、创建/合并 PR 记录，CSV 导出按钮可用。`019` 已将 `stage_id` 设为阶段持久化数据的正式主键/外键身份。
- Vercel 已配置 `CSRF_ALLOWED_ORIGINS=https://pr-helper.pages.dev`，覆盖 Production 和 Preview。
- PR #172 的首个 Vercel Preview 失败原因为 Vercel 对 `api/` 完整 TypeScript 编译，而仓库原 `tsconfig.json` 仅包含 `src/`；已将 `api/` 纳入检查并修复类型错误，修复提交为 `26e342a1`，已推送等待 Check 重跑。

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

### PR 流程自动化（本地代码已完成，待部署验收）

自动化方案已确认，详见 [`docs/automated-workflow-plan.md`](docs/automated-workflow-plan.md)。服务端加密 AI 凭据、`024`–`026`、步骤规则快照、幂等动作队列和 Webhook/Cron/inbox 后台触发已在本地落地；第一阶段不做画布。自动创建 PR 只有在服务端自动流程凭据可用、AI 设置中的“自动生成标题和描述”“自动确认创建”均开启，且存在有效生成规则快照时才允许用户启用；条件满足不会自动勾选，必须用户主动点击，默认规则优先。默认关闭自动合并、自动推进和生产高风险动作。

当前浏览器 AI Key 位于 `sessionStorage`，同一标签页刷新后仍存在；限制是后端无法读取，而不是刷新即丢失。它继续用于手动流程且不会自动上传。自动流程使用用户单独保存的服务端加密凭据；现有口令派生的加密云同步因服务端无法解密，不能复用。AI 失败处理第一版只生成修复上下文或 Codex 修复任务，不做无人值守代码修改、推送或生产合并。

当前本地已落地自动流程 AI 凭据、步骤级自动创建策略配置和规则快照、`025_workflow_automation_queue.sql` 对应的运行快照和幂等动作队列、`026_ai_automation_preferences.sql` 对应的服务端偏好，以及 webhook / cron / inbox reconciliation 的后台自动触发。`024`、`025`、`026` 已执行，Vercel Production/Preview 已配置 `AI_CREDENTIALS_ENCRYPTION_KEY`；代码尚未部署。本次执行器以稳定幂等键和 `queued → running` 原子领取防止重复创建，失败动作会暂停；不自动合并。

在上述生产验收通过后，建议顺序为：

1. 后台自动创建 PR：部署 Preview 后用测试仓库验证规则快照、Webhook/Cron 触发、幂等去重和失败暂停，再决定是否进入 Production。
2. 浏览器 E2E：已覆盖授权返回、新建/编辑流程、步骤排序、失败恢复、抽屉创建/合并 PR、删除流程和确认式回滚；Webhook 自动投影已有真实 delivery 证据。
3. 操作审计：`020` 已执行；Production 已完成流程更新、创建/合并 PR 记录读取及 CSV 导出可用性验收。✅
4. 加密云同步加固：已部署，`021` 已执行；待验证 v1/v2 兼容、口令轮换、冲突拒绝和历史恢复。
5. 历史数据保留与清理：已部署，`022` 已执行；待确认 Cron 产生成功运行记录并按批次清理历史数据。
6. 团队协作闭环：已部署团队管理界面、成员角色管理、流程共享、共享状态投影和服务端操作授权；`023` 已执行。需用至少两个 GitHub 账号验收角色边界与 GitHub App 安装范围。

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
