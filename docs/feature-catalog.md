# PR Helper · 产品功能点清单

> 梳理日期：2026-09-30
> 方法：结合 `handoff.md`、`docs/current-state.md`、各子代理审计素材，对代码（`src/`、`api/`、`supabase/migrations/`）逐项核对。
> 状态图例：✅ 已上线 · ✔ 已验收（生产真实数据）· 🟡 部分/后置 · ⏳ 待外部验收 · 🔧 设计中/待实施
> 每个功能点附代码证据（`文件:行号` 或迁移号）。

---

## 1. 账户与授权

| 功能 | 状态 | 证据 |
|---|---|---|
| GitHub App OAuth 登录（start/callback/install/logout，HMAC 签名 state 10min 过期） | ✅ | `api/auth/github/[action].ts:94` |
| 签名 HttpOnly + Secure + SameSite=Lax 会话 Cookie（7 天） | ✅ | `api/_lib/github-app.ts:94`、`http.ts:57` |
| Installation 绑定（写 `installationId` 入会话） | ✅ | `auth/github/[action].ts:58,74` |
| 登出清 Cookie | ✅ | `auth/github/[action].ts:89` |
| 隐私政策页（含零知识同步、不收集密钥/IP 声明） | ✅ | `public/privacy.html` |
| 账户删除端点 `DELETE /api/account`（依赖外键级联清理） | ✅ | `api/account.ts:5`、`workflows-store.ts:2959` |
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
| 当前步骤「第 N/总计 步」动态渲染 | ✅ | `main.ts:1231` `laneRunSummary` → `overview.run.current` |
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
| execute 模式（Zeus 凭据委托） | 🔧 | `a2a/skills.ts`(未实现，当前仅 plan 模式) |

## 14. 国际化 / 主题

| 功能 | 状态 | 证据 |
|---|---|---|
| 中英文本地化（zh/en） | ✅ | `src/lib/translations/*` |
| 深色主题 + token 守卫测试（防发明 token 名、`<dialog>` 继承、背景当文字色） | ✅ | `src/style-theme-tokens.test.ts`、`handoff.md:310-319` |

## 15. 测试与 CI

| 功能 | 状态 | 证据 |
|---|---|---|
| Vitest 单元（30+ 文件 / 660+ 项） | ✅ | `npm test` |
| Playwright 浏览器 E2E（31 test，端口 4373） | ✅ | `e2e/pr-helper.spec.ts` |
| CI：lint + 单测 + build | ✅ | `ci.yml` |
| 双平台部署（Vercel + Cloudflare Pages 同步） | ✅ | `deploy-vercel.yml` / `deploy-cloudflare-pages.yml` |
| 迁移一致性静态守卫（SELECT 列 ⊆ 迁移声明列，防 P8 类回归） | ✅ | `workflows-store.test.ts:688-728` |

---

## 功能成熟度总结

- **生产已验收（端到端真实数据）**：自动化创建/合并、汇聚/部署门禁、对账健康探针、失败处理中心修复、操作审计、Egress 优化、阶段稳定身份、流程版本锁、归档/恢复、双平台部署与确认式回滚。
- **已上线待外部验收（缺账号/环境）**：团队多账号角色边界、private/organization 安装边界、加密同步 v1/v2 与口令轮换、数据保留 Cron 观察、Webhook 自动投影（需登录态手测）。
- **部分/后置**：自动化进度条步骤级完整 UI、暂停动作接管交互细节、A2A execute 模式、浏览器 Push 真实闭页投递（依赖端到端补全）。
- **设计中/待实施**：删除 `pr_helper_workflows.payload` 列（双表示收口，普通代码债）、`version` 收紧 NOT NULL（并入上述方案 D 步）。

> 完整风险与待办仍以 `handoff.md` 的《待处理事项（2026-09-15 汇总）》为唯一索引；本报告与 `docs/code-audit-report.md` 互为补充（功能清单 + 风险审计）。
