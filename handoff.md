# PR Helper Handoff

> 最后更新：2026-08-03
> 当前事实来源：[`docs/current-state.md`](docs/current-state.md)。历史设计和计划不应作为当前需求或上线状态的依据。

## 当前状态

- 当前分支：`feature/20260722`。
- 用户已确认本批代码已上线 Production。
- 2026-08-03 验证报告见 [`docs/verification-report.md`](docs/verification-report.md)：真实 E2E 已通过 GitHub App 授权、PR 创建、严格门禁、应用内合并、合并后 Actions 与多路径汇聚；未通过项均已明确标注。
- 当前本地验证已通过：`npm test`（22 个文件 / 172 项）、`npm run test:e2e`（Playwright Chromium 9 项，API mock）、`npx tsc --noEmit`、`npm run lint`、`git diff --check`。
- Supabase 迁移 `001`–`020` 已执行；`021`–`023` 已在本地准备、尚未执行。操作审计读取已改为现有 `inbox` 函数的 `resource=operation-audit` 分流，未增加 Serverless Function 数量；Production 已显示流程更新、创建/合并 PR 记录，CSV 导出按钮可用。`019` 已将 `stage_id` 设为阶段持久化数据的正式主键/外键身份。
- Vercel 已配置 `CSRF_ALLOWED_ORIGINS=https://pr-helper.pages.dev`，覆盖 Production 和 Preview。

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

| 待办 | 需要准备 | 验收结论 |
| --- | --- | --- |
| Required approval | 第二个可审批 GitHub 账号，并在 E2E 分支保护中要求 1 个审批 | `needs-approval` → `ready-to-merge` |
| Vercel / Cloudflare 部署与回滚 | 低风险仓库、真实工作流/Environment/密钥、单独回滚窗口 | 双平台门禁、健康检查和确认式 Production 回滚可追溯 |
| GitHub Webhook 自动投影 | 可触发的 GitHub delivery 与 Vercel/Supabase 观察证据 | 无手动刷新时自动更新看板和时间线 |
| private / organization 安装边界 | 已授权 private 仓库和 organization 仓库，配置 GitHub App 仓库选择范围 | 授权范围正确生效，范围外访问被拒绝 |

不要为了验收立即触发 Production 回滚；该操作会真实改变线上版本，应仅在单独安排的低风险窗口执行。

## 后续高价值投入

在上述生产验收通过后，建议顺序为：

1. 浏览器 E2E：已覆盖授权返回、新建/编辑流程、步骤排序、失败恢复、抽屉创建/合并 PR、删除流程和确认式回滚；Webhook 自动投影仍需真实 GitHub delivery 验收。
2. 操作审计：`020` 已执行；Production 已完成流程更新、创建/合并 PR 记录读取及 CSV 导出可用性验收。✅
3. 加密云同步加固：本地已实现，待执行 `021` 并部署。
4. 历史数据保留与清理：本地已实现，待执行 `022` 并部署。
5. 团队权限模型：本地已实现角色判定、团队/成员/共享流程模型和管理 API；待执行 `023` 并部署。

不建议优先投入任意 DAG、流程模板市场、自动 Production 合并/回滚或自建 CI/CD 引擎。

## 常用命令

```bash
npm test
npm run test:e2e
npx tsc --noEmit
npm run lint
npm run dev
```

不要编辑或提交 `node_modules/`、`dist/`，不要把 GitHub/Vercel/Supabase 密钥写入仓库。
