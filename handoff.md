# PR Helper Handoff

> 最后更新：2026-08-03
> 当前事实来源：[`docs/current-state.md`](docs/current-state.md)。历史设计和计划不应作为当前需求或上线状态的依据。

## 当前状态

- 当前分支：`feature/20260722`。
- 用户已确认本批代码已上线 Production。
- 2026-08-03 验证报告见 [`docs/verification-report.md`](docs/verification-report.md)：真实 E2E 已通过 GitHub App 授权、PR 创建、严格门禁、应用内合并、合并后 Actions 与多路径汇聚；未通过项均已明确标注。
- 当前本地静态验证已通过：`npm test`（21 个文件 / 170 项）、`npx tsc --noEmit`、`npm run lint`、`git diff --check`。
- Supabase 迁移 `001`–`019` 已执行；`019` 已将 `stage_id` 设为阶段持久化数据的正式主键/外键身份。
- Vercel 已配置 `CSRF_ALLOWED_ORIGINS=https://pr-helper.pages.dev`，覆盖 Production 和 Preview。

## 本地待部署修复

以下改动只在本地工作区，尚未提交、推送或合并：

- GitHub App installation token 缓存与 15 秒 API 超时；前端待办队列 60 秒超时提示。
- 同一流程的远端保存串行队列，修复连续编辑自触发 `409` 的问题；新增 `src/lib/workflow-save-queue.test.ts`。
- 动态 Source（如 `fix/*`）从服务端投影逐条展示实际分支；详情手动刷新会校准投影，每条分支状态可打开现有失败恢复抽屉。
- 编辑器 `查看流程详情` 入口补齐导航事件。

Production 已复现而待部署复验的风险：

1. 快速连续保存同一流程会并发发送相同版本，触发服务器乐观锁 `409`。
2. 动态来源的详情展示已在本地改为消费服务端投影，但尚未部署；#4 的 Production 投影与失败恢复闭环仍没有通过证据。
3. `GET /api/inbox?refresh=1` 曾触发 Vercel 300 秒 `504`；本地超时/缓存改动部署后必须复验。

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

优先完成下列项目，不要立即追加复杂流程能力：

1. 部署本地待部署修复后，连续添加/删除流程步骤、部署门禁和恢复策略，确认不再出现 `409`，刷新后配置完整保留。
2. 在 `E2E Failure and Dynamic Rule` 中验证 PR #4（`fix/failure-e2e → dev`）显示 Actions 失败、禁止合并、生成 Codex 修复包，并只重跑一次 Actions 以验证冷却策略。
3. 点击“刷新队列”，确认 60 秒内成功或给出清晰超时，不再等待 Vercel 300 秒后 `504`。
4. 用第二个账户验证 required approval；再分别验证 private、organization 仓库安装边界。
5. 在单独低风险窗口配置真实部署后，验证 Vercel/Cloudflare 门禁、健康检查与确认式回滚。

不要为了验收立即触发 Production 回滚；该操作会真实改变线上版本，应仅在单独安排的低风险窗口执行。

## 后续高价值投入

在上述生产验收通过后，建议顺序为：

1. 浏览器 E2E：覆盖授权返回、新建/编辑流程、步骤排序、抽屉 PR 操作和失败恢复。
2. 完整操作审计：记录操作人、前后状态、GitHub 响应和失败原因。
3. 加密云同步加固：密钥轮换、设备恢复、多设备冲突和保留策略。
4. 历史数据保留与清理。
5. 团队权限模型：Owner、Editor、Operator、Viewer，Production 合并/回滚单独授权。

不建议优先投入任意 DAG、流程模板市场、自动 Production 合并/回滚或自建 CI/CD 引擎。

## 常用命令

```bash
npm test
npx tsc --noEmit
npm run lint
npm run dev
```

不要编辑或提交 `node_modules/`、`dist/`，不要把 GitHub/Vercel/Supabase 密钥写入仓库。
