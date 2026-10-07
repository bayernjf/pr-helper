# PR Helper · 产品功能点清单

> 本版梳理日期：2026-10-08（前次 2026-09-30；本版为增量合并，保留前次「生产已验收」状态判定，新增 §16 能力错配、§17 功能×测试覆盖，并更新测试计数与 PR 引用复制等新条目）
> 方法：结合 `handoff.md`、`docs/current-state.md`、各子代理审计素材，对代码（`src/`、`api/`、`supabase/migrations/`）逐项核对；以 `src/lib/translations/{en,zh}.ts` 的 717 个键名前缀作为功能地图，再回到代码确认实现。
> 状态图例：✅ 已上线 · ✔ 已验收（生产真实数据）· 🟡 部分/后置 · ⏳ 待外部验收 · 🔧 设计中/待实施 · ❌ 存在已确认缺陷
> 每个功能点附代码证据（`文件:行号` 或迁移号）。风险与缺陷详情见 [`code-audit-report.md`](code-audit-report.md)。

---

## 1. 账户与授权

| 功能 | 状态 | 证据 |
|---|---|---|
| GitHub App OAuth 登录（start/callback/install/logout，HMAC 签名 state 10min 过期） | ✅ | `api/auth/github/[action].ts:94` |
| 签名 HttpOnly + Secure + SameSite=Lax 会话 Cookie（7 天） | ✅ | `api/_lib/github-app.ts:94`、`http.ts:57` |
| Installation 绑定（写 `installationId` 入会话） | ✅ | `auth/github/[action].ts:58,74` |
| 登出清 Cookie | ✅ | `auth/github/[action].ts:89` |
| 隐私政策页（含零知识同步、不收集密钥/IP 声明） | ✅ | `public/privacy.html` |
| 账户删除端点 `DELETE /api/account`（依赖外键级联清理） | ❌ | `api/account.ts:5`、`workflows-store.ts:2959` 仅删 `pr_helper_users`，而 `023:18,34` 的 `created_by`/`shared_by` 为 `ON DELETE RESTRICT` → **建过团队或共享过流程的用户必然删除失败**（审计报告 P1） |
| GitHub 权限说明（⚠️ README 与隐私政策互悖，见审计报告 D4） | 🟡 | `README.md:68` vs `privacy.html:62` |

## 2. 看板 / 工作流管理（Lane Board）

| 功能 | 状态 | 证据 |
|---|---|---|
| Lane 看板总览 | ✅ | `src/main.ts` `overviewBoard` |
| 看板筛选：需要处理 / 正在运行 / 全部流程 / 失败 / 自动化受阻 / 归档 | ✅ | `main.ts:110`(类型)、`:1453-1475`(计数与匹配) |
| 筛选动态计数（各筛选项实时统计） | ✅ | `main.ts:1453-1475` |
| 自定义 Lane 排序（拖拽抬升/让位/归位动画 + 减少动态效果适配） | ✅ | `handoff.md:226-232`(2026-08-08) |
| 流程增 / 删 / 改 / 换仓库 | ✔ | E2E `e2e/pr-helper.spec.ts` |
| 阶段稳定身份 `stage_id`（主键/外键演进，状态不再按数组位置错配） | ✅ | 迁移 `018`/`019` |
| 流程版本并发控制（`version` 乐观锁） | ✅ | 迁移 `038`、store 层冲突检测 |
| 流程归档 / 恢复（可逆，停校准、取消动作） | ✔ | `handoff.md:168-184`(2026-08-17 验收) |
| 当前步骤「第 N/总计 步」动态渲染 | ✅ | `main.ts` `laneRunSummary` → `overview.run.current` |
| PR 引用一键复制（hover 显示完整地址 + tooltip 内跳转，点击复制到剪贴板） | ✅ | `src/lib/pr-reference.ts`、`main.ts` 5 处接入（看板摘要 / 失败中心 / 发布历史 / 时间线 / 步骤抽屉）、E2E `e2e/pr-helper.spec.ts` |
| 名称 / 仓库搜索 | ✅ | `main.ts:1474-1475`、`lane-search` |

## 3. 阶段与门禁（Stage & Gate）

| 功能 | 状态 | 证据 |
|---|---|---|
| 服务端统一阶段决策模型：`locked`/`waiting`/`checks-failed`/`needs-approval`/`ready-to-merge`/`ready-to-create`/`merged` | ✅ | `api/_lib/workflows-store.ts` `deriveStageDecision` |
| 动态源规则（`feature/*`+`fix/*` → `dev` → `main`） | ✅ | `src/lib/workflow.ts` `sourceRuleMatches` |
| 独立合并路由（fan-in / fan-out） | ✅ | `workflow.ts` |
| 汇聚门禁：依赖步骤全部 `merged+success`，排除已放弃（`closed`）路线 | ✔ | `handoff.md:321-325`(2026-08-22 验收) |
| 部署门禁（合并后门禁、红可自动变、探测上限） | ✔ | `handoff.md:336-346`(2026-08-22 双向验收) |
| 提交数阈值 `trigger_min_commits`（默认 1，夹取 1–20） | ✔ | `handoff.md:353-361`(首次实测) |
| 阶段运行呈现（tone: running/succeeded/failed/idle） | ✅ | `src/lib/workflow-run.ts:12` `stageRunPresentation` |
| 阶段投影（服务端直出，详情首屏 SWR + 30s TTL） | ✅ | `src/lib/projected-stage.ts`、`handoff.md:65-75`(2026-09-15) |

## 4. PR 创建与合并（手动）

| 功能 | 状态 | 证据 |
|---|---|---|
| 浏览器创建 PR（走 `/api/github/request` 代理） | ✅ | `src/lib/github.ts` |
| 浏览器合并 PR（确认后代理，`sha=pull.head.sha` 校验） | ✅ | `main.ts` 合并对话框 |
| 创建/合并门禁判定（`canCreateWorkflowStage`/`canMergeOpenPull`，SoT） | ✅ | `src/lib/domain.ts:103,117` |
| 失败重跑 Actions | ✔ | `handoff.md:204` |
| 部署回滚（确认式，服务端 dispatch `actions/workflows/{id}/dispatches`，`event_key` 幂等） | ✅ | `workflows-store.ts:1075`、`e2e` 二次确认 |

## 5. 自动化（服务端）

| 功能 | 状态 | 证据 |
|---|---|---|
| 自动创建 PR（create-pr） | ✔ | `handoff.md:269-294`(生产端到端跑通) |
| 自动合并 PR（merge-pr，状态独立于创建） | ✔ | `handoff.md:295`(2026-08-15 验收) |
| AI 自动生成标题/描述（需四项前置 + 规则快照 + 用户主动勾选） | ✅ | `handoff.md:272` |
| AI 凭据服务端加密存储（AES-256-GCM，`key_hint` 掩码） | ✅ | 迁移 `024`/`026`、`ai-credentials.ts` |
| 幂等动作队列（queued→running 原子领取，`(user_id,idempotency_key)` 唯一） | ✅ | `workflows-store.ts:84` |
| 失败动作 `paused` / 超 `maxRetries` 停 / 瞬时失败重排（冷却+窗口） | ✔ | `handoff.md:114-118`(2026-08-22 验收) |
| 暂停动作接管（用户重新生成/手动填，确认后 Unpause 复用原动作 ID） | 🟡 | `handoff.md:285`(交互细节后置) |
| 自动化进度条：详情页整体 + 步骤节点（读服务端 `decision`） | 🟡 | `handoff.md:278-282`(只读切片已上线，步骤级完整 UI 后置) |
| 阻止生产自动合并（AGENTS.md 第 5 条，设计约束） | ✅ | 设计约束 |

## 6. 对账与监控（Reconciliation & Monitoring）

| 功能 | 状态 | 证据 |
|---|---|---|
| 实时对账（webhook / inbox_refresh / manual） | ✅ | `workflows-store.ts` `reconcileRealtime` |
| 定时对账（pg_cron `*/30`，GitHub Actions `*/10` 兜底） | ✅ | 迁移 `030`/`033` |
| 对账预算与让出（webhook 25000 / inbox 6000 / cron 40000ms） | ✅ | `handoff.md:71,127-136` |
| 对账租约（自过期 TTL 30s、心跳续租、holder 守卫释放） | ✅ | 迁移 `028` |
| 收敛健康探针 `GET /api/cron/health`（超阈值返 503）+ reconcile workflow 报红 | ✔ | `handoff.md:138-139`(2026-08-19 验收) |
| 出站量优化（请求内去重、三刀 −94%、月投影 2.1GB/5GB） | ✔ | `handoff.md:299`、`docs/supabase-egress-optimization.md` |
| 失败处理中心（attention 队列，9 条假待办已修） | ✔ | `handoff.md:118`(2026-08-15 验收) |
| 失败恢复策略（`recovery-event` 端点） | ✅ | `api/[action].ts` |
| 分段耗时遥测（`phase_ms`、连接池 `max:4`） | ✅ | 迁移 `032`、`workflows-store.ts:980` |

## 7. 部署与回滚

| 功能 | 状态 | 证据 |
|---|---|---|
| 部署追踪（拉 Actions run + 健康 URL，先比后写省写） | ✅ | `workflows-store.ts:2549,1838` |
| 部署健康探测（合并后门禁，红可自动变、不能自动变绿） | ✔ | `handoff.md:336-346` |
| 确认式 Production 回滚（Vercel + Cloudflare，二次 `gh api` 核验 run） | ✅ | `rollback-frontend-deployment.yml:43-105` |

## 8. 同步（Sync）

| 功能 | 状态 | 证据 |
|---|---|---|
| 浏览器本地持久化（localStorage：workflows/rules/drafts/theme/device-id） | ✅ | `main.ts:150,175,736,159,176` |
| 离线 / local-only 模式（`localViteWithoutApi` → `localModeNotice`） | ✅ | `main.ts:55,330` |
| 本地 → 云端同步（`syncLocalWorkflows` 逐条上云） | ✅ | `main.ts:679-688` |
| 加密云同步（AES-GCM + PBKDF2 600k，零知识，v1/v2 + 口令轮换 + 409 冲突） | 🟡 | 迁移 `016`/`021`、E2E 待回归（handoff 待办） |

## 9. 团队（Team）

| 功能 | 状态 | 证据 |
|---|---|---|
| 团队管理界面 | ✅ | 迁移 `023` |
| 成员角色管理（Owner/Editor/Operator/Viewer） | ✅ | `src/lib/team-permissions.ts`、`023` |
| 流程共享 | ✅ | `pr_helper_team_workflows`(023) |
| 共享状态投影 + 服务端操作授权 | ✅ | `workflows-store.ts` `requireWorkflowOperation:1410` |
| 多账号角色边界验收（private/organization 安装、双账号） | ⏳ | `handoff.md` 外部条件待办 |

## 10. AI 生成

| 功能 | 状态 | 证据 |
|---|---|---|
| AI 配置（base_url/model，强制公网 HTTPS） | ✅ | `ai-credentials.ts` `validateAiBaseUrl` |
| 流式生成 PR 标题/描述（SSE 增量 JSON 解析） | ✅ | `src/lib/ai-stream.ts:290` |
| 连通性测试（解密凭据实测，15s 超时，不回 Key） | ✅ | `handoff.md:15`(提交 b61e2d3e) |
| 生成失败动作暂停（保留脱敏原因，用户接管） | ✅ | `handoff.md:272` |

## 11. 审计与合规

| 功能 | 状态 | 证据 |
|---|---|---|
| 操作审计日志（迁移 `020`，8 种 action CHECK，CSV 导出） | ✔ | `handoff.md:303`(生产验收) |
| 阶段事件记录（`workflow_stage_events`，`event_key` 去重） | ✅ | 迁移 `008` |
| 数据保留与清理（webhook 30 / audit 365 等，cron 分批） | 🟡 | 迁移 `022`、待 Cron 观察 |

## 12. 通知（Notifications）

| 功能 | 状态 | 证据 |
|---|---|---|
| Web Push 公钥 / 订阅（VAPID） | ✅ | 迁移 `006`、`push.ts` |
| Service Worker 交付 | ✅ | `public/push-sw.js` |
| 浏览器 Push 真实闭页投递（需 SW/VAPID/订阅/对账齐全，否则降级态） | 🟡 | `AGENTS.md` 第 8 条（降级态保留） |

## 13. A2A / Agent

| 功能 | 状态 | 证据 |
|---|---|---|
| Agent Card 暴露（`/.well-known/agent.json`，vercel rewrite） | ✅ | `api/a2a/agent-card.ts`、`vercel.json` |
| A2A JSON-RPC（`tasks/send`，任务存内存） | 🟡 | `agent-card.ts:18`、`a2a/task-store.ts`(内存态，跨实例丢失) |
| execute 模式（Zeus 凭据委托） | 🔧 | `a2a/skills.ts:36-41`(未实现，当前仅 plan 模式) |
| SSE 流式订阅 | 🟡 | 卡片声明 `streaming:true`，但 `executeTask` 同步完成、事件一次性刷出（`agent-card.ts:71-81`）——声明超前于实现 |
| 前端 UI 入口 | ❌ | **无任何入口**：A2A 6 文件 696 行纯后端能力，`src/` 零引用 |
| 端点文档正确性 | ❌ | `docs/a2a-vassal.md:9,57,63` 写 `POST /api/a2a/tasks`，该文件不存在，实际挂在 `POST /api/a2a/agent-card` → 照文档实现的第三方客户端全部 404 |

## 14. 国际化 / 主题

| 功能 | 状态 | 证据 |
|---|---|---|
| 中英文本地化（zh/en） | ✅ | `src/lib/translations/*` |
| 深色主题 + token 守卫测试（防发明 token 名、`<dialog>` 继承、背景当文字色） | ✅ | `src/style-theme-tokens.test.ts`、`handoff.md:310-319` |

## 15. 测试与 CI

| 功能 | 状态 | 证据 |
|---|---|---|
| Vitest 单元（33 文件 / 716 项，2026-10-08 实测） | ✅ | `npm test` |
| Playwright 浏览器 E2E（30 test，端口 4373，全部桩化后端） | ✅ | `e2e/pr-helper.spec.ts` |
| CI：lint + 单测 + build | 🟡 | `ci.yml` —— **不含 `tsc --noEmit`、不跑 e2e、部署不被其门禁**（审计报告 §5.1） |
| 双平台部署（Vercel + Cloudflare Pages 同步） | 🟡 | `deploy-vercel.yml` / `deploy-cloudflare-pages.yml` —— 两平台构建来源不同构，CF 侧 `VITE_AUTH_ORIGIN` 无存在性校验 |
| 迁移一致性静态守卫（SELECT 列 ⊆ 迁移声明列，防 P8 类回归） | ✅ | `workflows-store.test.ts:688-728` |
| 迁移规范检查器 `tools/check-migrations.sh` | 🟡 | 脚本可用（实测 40 文件 39 warning），但**未被 CI / package.json / 文档任何一处引用** |

## 16. 能力错配与缺口

以代码为唯一事实来源核对出的「前后端不匹配」「承诺与实现不匹配」条目：

| 类型 | 具体 | 证据 |
|---|---|---|
| 后端有、前端无 | A2A 全套能力无任何 UI 入口 | `api/_lib/a2a/`、`api/a2a/` |
| 半成品 | A2A 只能 plan，不能 execute | `a2a/skills.ts:36-41` |
| 夸大声明 | Agent Card `streaming: true` 与同步实现不符 | `api/_lib/agent-card.ts:56` |
| 功能缺失 | Markdown 生成规则**没有删除入口**，库层也无 delete 函数 | `src/lib/generation-rules.ts` |
| 已确认缺陷 | 账户删除对团队创建者必然失败 | 见 §1 |
| 可能不可用 | 流程预检唯一入口 URL 疑似 404（`/api?action=preflight`，无 `api/index.ts`，rewrite 不覆盖） | `main.ts:1243`，**待线上验证** |
| 死代码 | `executeAutoCreatePr()` 有实现无调用方（孤儿键 `automation.executeCreate`） | `main.ts` |
| 死代码 | `domain.ts getStageAction`+`StageInput`、`workflow-save-queue.ts whenIdle`/`hasPendingEdits`、`encrypted-sync.ts getCloudSyncKeyId`/`rotateCloudSyncKey`(仅别名)、`workflow.ts deploymentConfigsForTarget`、`app-name.ts`(仅自测) | 逐项 grep 无引用 |
| 文档残留 | 19 个孤儿翻译键（en/zh 各 717 键完全对齐；其中 13 个属旧版 Overview 设计） | `translations/{en,zh}.ts` |
| 依赖卫生 | 7 个运行时零引用依赖（react/react-dom/next/tailwindcss/postcss/autoprefixer/eslint）+ 2 个多余 @types；`npm run lint` 实为 vite build | `package.json`，全仓 import 零命中 |

## 17. 功能 × 测试覆盖

覆盖等级：`e2e` = 真实 Chromium 驱动（但桩化后端）；`unit` = 纯函数真行为测试；`src-text` = **仅断言源码字符串，不执行行为，等于无覆盖**；`无` = 未覆盖。

| 功能域 | 覆盖 | 说明 |
|---|---|---|
| 看板渲染 / 筛选 / 排序 / 重排 / 换仓库 | e2e | 30 例中占多数 |
| 步骤抽屉、PR 创建与合并、失败重跑 | e2e | 断言经 GitHub 代理提交的准确负载 |
| 进度条前缀统计、主题色守卫、部署行按钮布局 | e2e | |
| PR 引用复制与 tooltip | e2e | 2026-10-08 新增 |
| 纯函数投影层（domain / workflow / workflow-run / team-permissions / projected-stage / pr-drafts / navigation / generation-rules） | unit | 覆盖良好，无 mock |
| GitHub App JWT、HTTP 工具、A2A RPC、cron handler、加密模块 | unit | 47 / 18 / 14 / 11 / 13 例 |
| **对账主循环** `reconcileWorkflowStages` | src-text | `workflows-store.test.ts:780` |
| **Webhook 投影** `projectPullRequestWebhook` | src-text | `:813` |
| **账号删除** `deleteAccount` | 无 | 测试文件零引用 |
| **生产回滚** `requestDeploymentRollback` | 无 | 同上 |
| **团队 CRUD 与 RBAC** `createTeam` / `authorizeWorkflowOperation` | 无 | 同上 |
| **数据保留** `cleanupRetainedData` | 无 | 同上 |
| **自动化执行** `executeWorkflowAutomationAction` | 无 | 同上 |
| Supabase 数据访问层整体 | 无 | 全仓 0 处 `vi.mock`，无 DB 测试装置 |
| CSRF / Webhook 签名 / 隐私页 / Push 订阅 | 无 | 无专项 e2e，安全端点仅靠零散单测 |
| e2e 是否进 CI | — | **不进**，`ci.yml` 无 Playwright 步骤 |

---

## 功能成熟度总结

- **生产已验收（端到端真实数据）**：自动化创建/合并、汇聚/部署门禁、对账健康探针、失败处理中心修复、操作审计、Egress 优化、阶段稳定身份、流程版本锁、归档/恢复、双平台部署与确认式回滚。
- **已上线待外部验收（缺账号/环境）**：团队多账号角色边界、private/organization 安装边界、加密同步 v1/v2 与口令轮换、数据保留 Cron 观察、Webhook 自动投影（需登录态手测）。
- **部分/后置**：自动化进度条步骤级完整 UI、暂停动作接管交互细节、A2A execute 模式、A2A SSE 真流式、浏览器 Push 真实闭页投递（依赖端到端补全）。
- **存在已确认缺陷**：账户删除对团队创建者失败（§1）、A2A 对外文档端点错误（§13）、生成规则无删除入口（§16）。
- **待运行时验证**：流程预检入口 URL 是否 404（§16）。
- **设计中/待实施**：删除 `pr_helper_workflows.payload` 列（双表示收口，普通代码债）、`version` 收紧 NOT NULL（并入上述方案 D 步）。

> 完整风险与待办仍以 `handoff.md` 的《待处理事项（2026-09-15 汇总）》为唯一索引；本报告与 [`docs/code-audit-report.md`](code-audit-report.md) 互为补充（功能清单 + 风险审计）。
