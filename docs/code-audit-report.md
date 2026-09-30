# PR Helper · 项目级代码审计报告

> 审计日期：2026-09-30
> 审计范围：整个仓库（前端 `src/`、服务端 `api/`、数据库迁移 `supabase/migrations/001–040`、CI/CD `.github/workflows/`、公共资产 `public/`、E2E `e2e/`）。
> 审计方法：静态源码审查 + 4 个并行子代理分域深挖（API 层 / 数据库层 / 前端层 / 安全·合规·CI·运维）。本文为汇总，详细证据见各子代理原始素材。
> 重要前提：本文基于**源码静态审计**，未执行运行时 / 渗透测试。涉及外键级联、RLS 生效、FK 行为等结论，已标注需结合迁移或线上核对确认。

---

## 0. 执行摘要

PR Helper 是一个 **GitHub-first 的 PR / 发布控制塔**：用 GitHub App 授权，通过 Webhook + 定时对账（reconciliation）驱动真实 PR/部署工作流，覆盖多仓库、多阶段、动态源规则、汇聚门禁与确认式 Production 回滚。

**整体评价**：架构清晰、安全基座扎实（会话 HMAC 签名、HttpOnly+Secure+SameSite 会话、Installation Token 不进浏览器、Webhook 验签、GitHub 代理白名单、团队 RBAC、操作审计、加密云同步零知识模型、级联删除、确认式回滚、pg_cron 对账 + 预算让出）。代码质量较高，迁移规范良好（无运行时 DDL、序号连续、无硬单向门），并已配 CI 单测 + 浏览器 E2E。

**首要风险**集中在三处：
1. **A2A 端点 fail-open 鉴权**：`ZEUS_A2A_TOKEN` 未配置时匿名可访问（中危）。
2. **限流 / 缓存跨实例失效**：模块级 `Map` 在 Vercel Serverless 多实例下形同虚设；drain 无独立锁。
3. **文档漂移严重**：AGENTS/README/隐私政策与代码实现多处矛盾，其中「AI 密钥是否在服务端持久化」在隐私策略与代码层面直接冲突（合规风险）。

此外 RLS 安全态**游离于迁移之外**（表启用 RLS 但零 policy、零迁移记录），属治理缺口。

---

## 1. 技术栈与架构

| 层 | 技术 | 说明 |
|---|---|---|
| 浏览器 | Vite + 原生 TypeScript（**无 React/Next**） + CSS | 看板、对话框、AI 流式、本地持久化 |
| API | Vercel Serverless Functions（`api/**/*.ts`） | 文件路由：`api/x.ts → /api/x` |
| 认证/集成 | GitHub App OAuth + 签名 HttpOnly 会话 + 短生命周期 Installation Token | 密钥全在服务端 |
| 持久化 | Supabase Postgres（`DATABASE_URL`） | 唯一事实来源是 `supabase/migrations/001–040` |
| 监控 | GitHub Webhook + 定时对账 + 收敛健康探针 | Web Push（web-push + Service Worker） |
| 测试 | Vitest（单元）+ Playwright（浏览器 E2E，端口 4373） | `npm test` / `npm run test:e2e` |
| 部署 | Vercel（canonical 安全 API）+ Cloudflare Pages（静态镜像） | 双平台同步部署同一份 `dist/` |

**关键常量（部分）**：会话 7 天、限流 60s/60 次、连接池 `max:4`、对账预算 webhook 8000ms / inbox_refresh 6000ms / cron 40000ms、收敛阈值 45min（生产经 env 调至 9000s）、阶段陈旧 15min。

---

## 2. 服务端 API 层审计

**入口清单（节选，完整表见子代理素材）**

| 路由 | 文件:行 | 职责 |
|---|---|---|
| `DELETE /api/account` | `account.ts:5` | 删除账号、清 session |
| `GET/POST /api/<action>`（inbox/recovery-event/rerun-actions/deployment-rollback/repair-context/preflight） | `[action].ts:133` | 收件箱投影、失败恢复、重跑、回滚、修复上下文、预检 |
| `GET/PUT/PATCH/DELETE /api/workflows`（resource: ai-credentials/automation/teams） | `workflows.ts:25` | 工作流 CRUD、AI 凭据、团队、自动化入队 |
| `GET/POST /api/encrypted-sync` | `encrypted-sync.ts:10` | 端到端加密云同步（密文仅存） |
| `GET /api/auth/github/<action>` | `auth/github/[action].ts:94` | OAuth 登录全流程、登出 |
| `GET/POST/PUT /api/github/<action>` | `github/[action].ts:122` | 会话探针 + **代理** GitHub REST |
| `POST /api/github/webhook` | `github/webhook.ts:17` | 接收 Webhook（raw body + 验签） |
| `GET/POST /api/notifications/<action>` | `notifications/[action].ts:35` | Web Push 公钥与订阅 |
| `GET /api/cron/{drain,health,reconcile}` | `cron/*.ts:10` | 排空 / 健康探针 / 定时对账 |
| `GET/HEAD/POST /api/a2a/agent-card` | `a2a/agent-card.ts:35` | Agent Card + A2A JSON-RPC |

> 注：用户清单里的 `request-protection / csrf / validation / audit / encrypted-sync / installation-token` 并非独立文件，而是内联在 `http.ts / github-app.ts / workflows-store.ts / push.ts / github-api.ts` 中。

**认证与会话**
- OAuth：`auth/github/[action].ts:15` 发起（HMAC 签名 `state`，10min 过期）→ `:31` 回调（比对 + 换码 + 签 7 天 cookie）→ `:58/:74` 安装绑定 → `:89` 登出。
- 会话：`github-app.ts:94 createSignedSession`（`payload.base64url + '.' + HMAC-SHA256`）；`http.ts:57 setSecureCookie`（`HttpOnly; Secure; SameSite=Lax`）。密钥 `AUTH_SESSION_SECRET`。
- Installation Token：`github-api.ts:84` 取，`github-api.ts:12-13` 两个模块级 `Map` 缓存（60s 提前刷新 + in-flight Promise 去重）。**仅服务端内存，经代理，浏览器拿不到 token**。

**请求保护**
- CSRF：`http.ts:23 requestOriginAllowed`（合并 `APP_ORIGIN` + `CSRF_ALLOWED_ORIGINS`）；`http.ts:32 assertRequestOrigin` 仅对变更请求校验，失败 403。⚠️ `!origin` 时直接放行（`:25`）。
- 限流：`rate-limit.ts:7 consumeRateLimit` 滑动窗口 60s/60 次，key = `login:action`，仅 mutation 扣减。⚠️ **进程内 Map，跨实例失效**。
- 幂等：自动化入队 `workflows-store.ts:84` 用 DB 唯一约束 `(user_id, idempotency_key)`；`ON CONFLICT DO UPDATE`。
- 并发：执行器 `UPDATE … SET state='running' … WHERE state='queued' RETURNING` 乐观 claim；无 `pg_advisory_lock`，drain 仅靠行状态机。
- 输入校验：JSON.parse + 类型断言集中 store 层；SQL 经 `postgres` 参数化（`visibleWorkflowPredicate:1417` 仅对**静态列名** `sql.unsafe`，值均参数化）——未见字符串拼接注入。
- GitHub 代理白名单：`github/[action].ts:46 isAllowedGithubRequest`（路径+方法）；`operationForGithubMutation:19` + `authorizeWorkflowOperation:1446` 团队角色校验。

**核心业务逻辑（workflows-store.ts，6000+ 行，函数级）**
- 用户/权限：`userForLogin:1006`、`workflowAccessForUser:1387`、`requireWorkflowOperation:1410`、`visibleWorkflowPredicate:1417`。
- 持久化：`upsertWorkflow:1634`、`removeWorkflow`、`removeWorkflowStage:94`。
- 投影读取：`listWorkflows:1551`、`VisibleWorkflowReads` 记忆化（`:1428` 去重，防 N+1）。
- 对账：`reconcileWorkflowStages:2429`（含 cron reaper `:2440`）、`reconcileRealtime:2492`（预算 `withStageDeadline`）、`closeAbandonedReconciliationRuns:2418`。
- 动作队列：`enqueueWorkflowAutomationAction:84`、`drainWorkflowAutomationActions:427`、`automationDrainDecision:363`、`executeWorkflowAutomationActionForUser:565`、`runAutomationMergeAction:520`。
- 部署追踪：`listWorkflowStageDeployments:2549`、`deploymentRowChanged:1838`（先比后写省写）。
- 审计/回滚/团队/账号删除/数据保留/加密同步：均有对应函数（`:994 / :1075 / :2902 / :2959 / :2862 / :2824`）。

**GitHub 集成边界（对照 AGENTS.md 第 6 条）**：App 私钥、client_secret、会话密钥、Installation Token、Webhook Secret、用户 AI Key 明文、CRON_SECRET、ZEUS_A2A_TOKEN 均**不出浏览器**；`/api/github/session` 仅回登录态不泄露令牌。✅ 符合。

---

## 3. 数据库与持久化层审计

**数据模型（26 张表，按功能分组）**
- 用户/团队：`pr_helper_users`(001)、`pr_helper_teams`(023)、`pr_helper_team_members`(023)、`pr_helper_team_workflows`(023)
- 工作流：`pr_helper_workflows`(001，payload 仍为真源；036/038 提升列 name/repository/archived/version 为 NOT NULL)、`pr_helper_workflow_stages`(036 关系化镜像)
- 阶段状态：`workflow_stage_states`(004→019 主键演进为 `(user_id,workflow_id,stage_id,source)`)、`workflow_stage_events`(008)、`workflow_runs`(015)
- 部署：`workflow_stage_deployments`(010)、`workflow_stage_deployment_runs`(013)、`workflow_deployment_configs`(036)
- 监控/事件/Webhook：`workflow_stage_states` 挂载监控列(005/007)、`github_webhook_deliveries`(003)
- 通知：`pr_helper_push_subscriptions`(006)、`pr_helper_notification_deliveries`(006)
- 审计：`workflow_operation_audit_logs`(020，不可变、8 种 action CHECK、`workflow_id` 仅 text 无 FK)
- 自动化：`workflow_automation_runs`(025)、`workflow_automation_actions`(025，无 `stage_index` 列——见一致性)、`pr_helper_ai_automation_credentials`(024)
- 对账：`reconciliation_runs`(014→031)、`reconciliation_leases`(028)、`data_retention_runs`(022)
- 加密同步/生成规则：`pr_helper_encrypted_sync`(016)+`history`(021)、`pr_helper_generation_rules`(035，按 sha256 去重省 63% payload 读)

**迁移规范（良好）**：全文搜索 `CREATE/ALTER/DROP TABLE|INDEX|EXTENSION` 在 `workflows-store.ts` 中 0 命中（无运行时 DDL）；序号 `001–040` 连续无跳号；`DROP COLUMN/TABLE` 0 命中（无硬单向门）；每个变更都是新增文件，不改写已应用迁移。

**数据一致性**
- **P8 bug 已修复**：`workflow_automation_actions` 无 `stage_index` 列（025 只建在 runs 上），曾致动作永久卡 `queued`。现 `execute…:568` 与 `list…:641` 均 `JOIN workflow_automation_runs runs … runs.stage_index` 取列；并有静态一致性护栏 `workflows-store.test.ts:688–728`（断言 SELECT 列 ⊆ 迁移声明列）。
- **死列（写了不读）**：`workflow_versions.snapshot`(015:17) 全库无 SELECT 读者；`workflow_runs.stage_snapshot`(015:33) 无读者（测试 `:852` 确认）。`workflow_automation_runs.workflow_snapshot` 为 LIVE（drain 读取）。
- 除已修 P8 外，未发现「代码引用但迁移未建」的列。

**安全 / RLS（治理缺口）**
- 迁移文件 0 条 `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY`。但运维调试文档 `docs/supabase-readonly-debugging.md:181-207` 表明：**这些表启用了 RLS 且没有任何 policy → 默认拒绝**；且 `prh_readonly` 经 `alter role … bypassrls` 获万能读。**RLS 安全态不在迁移这一「唯一事实来源」内**，是治理缺口。
- 租户隔离：完全靠应用层 `WHERE user_id =` / `visibleWorkflowPredicate:1417`；DB 层无行级隔离。应用以所有者角色连库，故 RLS 不挡应用；若将来以非所有者连库会致命。
- 敏感数据：`ai_automation_credentials.ciphertext`(024)、`encrypted_sync.ciphertext`(016) 仅存密文，密钥在 Vercel env / 浏览器口令，服务端不解密。✅
- ⚠️ 迁移 `030:46` **硬编码生产 URL** `https://pr-helper-ten.vercel.app/api/cron/`，环境耦合、不可移植。

**性能 / 规模**
- 大 JSONB 热点：`pr_helper_workflows.payload`（35 行≈70.8kB，曾单次 inbox 被 5 个 list 各读一遍=354kB/588kB）。Egress 优化后单次 594→274kB、前台 71→16.4MB/小时（−94%）。
- 索引：`038` 表达式索引 `(repository) WHERE archived=false`；`034` 索引后被 `039` DROP（因 `038` 下推）。
- 连接池：`workflows-store.ts:980` `postgres(url, { max:4, prepare:false, … })`，单一池（无独立只读池）。

---

## 4. 前端层审计

**模块职责（src/lib/，17 个模块）**：`domain.ts`（门禁决策/URL/check 聚合，**SoT**）、`workflow.ts`（类型/Lane 排序/部署配置/自动化即时效应/串行保存，**SoT**）、`workflow-run.ts`（run 表达/动作表达/进度条节点读服务端 `decision`，**SoT**）、`navigation.ts`、`i18n.ts`（无单测）、`app-name.ts`、`ai.ts`、`ai-stream.ts`、`workflow-save-queue.ts`（按 workflow 串行合并）、`action-queue-request-queue.ts`（对账请求串行防竞态）、`encrypted-sync.ts`（AES-GCM+PBKDF2 零知识）、`pr-drafts.ts`（24h TTL/上限 50）、`generation-rules.ts`、`github.ts`（**唯一** GitHub API 边界）、`team-permissions.ts`、`projected-stage.ts`（详情首屏投影 + 30s TTL）。

**SoT 违反核对结论：未发现违反 AGENTS.md 第 1 条**。看板/详情均读服务端投影（`workflowStageStates[].decision`、`automationActions[].state`）而非 DOM 重算门禁。仅 `dynamicBranchStatusText`(main.ts:1613)、`drawerStatusText`(L1103) 内联重述 `canMergeOpenPull` 条件（展示级冗余，建议复用）。

**状态管理**：main.ts 顶层约 80 个模块级 `let`（L57–137）。本地持久化走 `localStorage`（workflows/generation-rules/pr-drafts/theme/device-id）；会话态 `token`/`aiConfig` 在 `sessionStorage`。离线/local-only：`localViteWithoutApi` 走 `localModeNotice`；登录云端后本地数据可 `syncLocalWorkflows` 上云。版本冲突由 `applyAuthoritativeWorkflow`/`applyQueuedWorkflowSave` 按 `version` 解决。

**安全边界**：App 模式下 `token=''`，所有请求经 `/api/github/request` 代理（App secret/Installation Token 不出浏览器）；PAT 模式下用户 PAT 存 `sessionStorage` 直连（符合 AGENTS#6，禁止的是 App secret 非用户 PAT）。AI Key 存 `sessionStorage('pr-helper-ai')` 仅会话期、不落服务端。加密同步口令仅驻内存，blob 格式 `v2:keyId:salt:iv:ciphertext`，server 只见密文、409 冲突处理。✅

**测试覆盖**：`src` 下 19 个 `*.test.ts`，覆盖所有 `lib/` 模块。**缺口**：`i18n.ts` 无单测；`main.ts` 仅 3 个测试，未覆盖看板筛选计数（`overview` L1453–1475）、`render()`、步骤抽屉、合并/创建/回滚/重试对话框、router、投影解析——这些 SoT 消费点缺单测，回归风险最高。

**看板筛选**：状态 `'all'|'attention'|'running'|'failed'|'automation'|'archived'`（main.ts:110）。计数：attention=`actionQueue.length`；running=attention 命中 **或** `tone==='running'`；failed=`kind==='checks-failed'`；automation=`blockedAutomationActions()`；archived=`archivedWorkflows().length`。**关系**：`需要处理(attention) ⊆ 正在运行(running)`（真子集）。「第 N/总计 步」由 `laneRunSummary`(L1231) → `overview.run.current` 渲染。

**技术债**：DOM 展示级重复 SoT 条件；`1209/1214` 部署运行时阈值（10/20min）为内联魔法数未提常量；疑似未用导出 `getStageAction`/`statusChanged`/`needsNewPullRequest`；阈值上限 `Math.min(20, triggerMinCommits)` 在 workflow.ts:246 与 main.ts:2267 各一份；**不存在独立「接管」对话框**——人工接管由 attention 队列消解 + `markAutomationResolved` 实现（审计简报需对齐）。主题 token 失配已被 `style-theme-tokens.test.ts` 守护，当前无失配。

---

## 5. 安全 / 合规 / CI-CD / 运维审计

**CI/CD（5 个 workflow）**
- `ci.yml`：PR + push(dev/main)，lint+单测+build，`cancel-in-progress`。
- `deploy-vercel.yml`：`vercel build --prebuilt`，environment `production-vercel`。
- `deploy-cloudflare-pages.yml`：Cloudflare Pages 镜像，`VITE_AUTH_ORIGIN` 注入指向 Vercel。
- `reconcile-pr-helper.yml`：`schedule */10` 兜底（pg_cron 为主时钟），缺 secret 则跳过 warning。
- `rollback-frontend-deployment.yml`：**确认式** Production 回滚——仅 `workflow_dispatch`、必填 inputs、`environment==production`、校验 `deployment_url` host、二次 `gh api` 核验 run 真实性、GitHub Environment 可挂 Required approval、concurrency 防并发。

**安全机制对照表**

| 机制 | 位置 | 评价 |
|---|---|---|
| CSRF/来源 | `http.ts:23-34` | ⚠️ `Origin` 缺失即放行 + `SameSite=Lax` 顶层表单 POST 可绕过 |
| 会话 | `github-app.ts:94-111` | HMAC+`timingSafeEqual`，HttpOnly+Secure+Lax，7 天 ✅ |
| 限流 | `rate-limit.ts` + `session.ts:15-19` | ⚠️ 进程内 Map、按 login、无 IP、跨实例失效 |
| 幂等/并发 | `workflows-store.ts:2824` / `webhook.ts:29` / 回滚 runId | 乐观锁 + 去重 ✅ |
| GitHub 代理白名单 | `github/[action].ts:46` | 路径+方法 + 团队授权 + 审计 ✅ |
| Webhook 签名 | `webhook.ts:20-24` | `x-hub-signature-256` + `timingSafeEqual`，raw body ✅ |
| 审计 | store 层 + 代理变更 | 较全；**缺口**：`DELETE /api/account` 与 encrypted-sync save 未显式审计 |
| A2A 鉴权 | `a2a/agent-card.ts:47-53` | ⚠️ **fail-open**：无 `ZEUS_A2A_TOKEN` 即匿名可访问 tasks/send |

**合规与隐私**
- 隐私政策 `public/privacy.html`：收集 GitHub 登录/ID/头像、流程配置、监控数据；localStorage 本地数据；服务端 Supabase(AWS)；加密云同步零知识；**不收集私钥/安装令牌/AI 密钥/分析 Cookie/IP**；第三方 GitHub/Vercel/Cloudflare/Supabase。
- 账户删除 `api/account.ts:5` → `deleteAccount`(`workflows-store.ts:2959`) 仅删 `pr_helper_users` 一行，**依赖外键 ON DELETE CASCADE**。核查：用户域表均 `CASCADE`（001/004/006/008/016/020/021/024/025/035 等）→ 隐私政策「流程/监控/同步/推送全删」属实。⚠️ 边角：`pr_helper_teams.created_by` 与 `team_workflows.shared_by` 为 `ON DELETE RESTRICT`(023) → 团队创建者删除可能被外键阻止（需先解散所有权）。
- 数据保留：迁移 022，`RETENTION_DAYS` = webhook 30 / syncHistory 30 / reconciliation 90 / stageEvents 180 / deploymentRuns 180 / audit 365 天，cron 分批清理。✅

**密钥管理（必需环境变量）**：GitHub App（`GITHUB_APP_*`）、`GITHUB_WEBHOOK_SECRET`、`AUTH_SESSION_SECRET`、`APP_ORIGIN`/`CSRF_ALLOWED_ORIGINS`、`DATABASE_URL`、`CRON_SECRET`（来自 `PR_HELPER_CRON_SECRET`）、`VAPID_*`、`AI_CREDENTIALS_ENCRYPTION_KEY`(32B)、`ZEUS_A2A_TOKEN`（⚠️ 文档未列）、部署 `VERCEL_*`/`CLOUDFLARE_*`、运行时调参若干。全仓搜索 `sk-/ghp_/eyJ/` 等 **0 命中**（无硬编码密钥）；`.env.local` 已 `.gitignore` 忽略。

**双平台一致性**：Vercel=canonical 安全 API + Cookie 签发；Cloudflare Pages=静态镜像，`VITE_AUTH_ORIGIN` 指向 Vercel；写操作边界：CF 因 `SameSite=Lax` 无法保持登录态写入，授权后跳回 Vercel。⚠️ **prebuilt 约束**：生产是 Actions 上传的 prebuilt 产物，面板 Redeploy 会被拒，改 env 后须 `gh workflow run deploy-vercel.yml --ref main`（`vercel pull` 拉最新 env）。实验变量 `REALTIME_RECONCILE_BUDGET_MS` 若残留会覆盖新常量，部署前须 `vercel env rm`。

**可靠性工程**：对账主时钟 = pg_cron + pg_net（drain 每 2min / reconcile 每 30min，033 改 `*/30`）；`/api/cron/health` 仅对未归档 workflow 计数，最老投影超阈值返 503；预算让出：超预算记 `degraded` + 置 `reconcile_pending_since` 由 webhook/cron 接力；租约 `027/028/029` 防重复与回收被中断 run。⚠️ `reconcile-pr-helper.yml:77` 自陈「degraded 仍返 200，健康探针只在完全不收敛时报警」→ 局部降级可能被掩盖。

**E2E 覆盖**：`e2e/pr-helper.spec.ts` 共 31 个 test（Playwright，端口 4373），覆盖授权、审计、流程增删改/排序/换仓库、PR 创建/合并、失败重跑、自动创建/合并策略、部署回滚二次确认、门禁与预检、进度条等。⚠️ **缺口**：无 CSRF、Webhook 签名、账户删除、隐私页、Push 订阅的专项 E2E（安全端点仅靠单测覆盖）。

---

## 6. 文档漂移专项（代码 vs 文档）

| # | 文档说法 | 实际（证据） |
|---|---|---|
| D1 | `AGENTS.md:16,41` 写迁移目录 `db/migrations/`、基线 `001–031` | 实际 `supabase/migrations/`，最高 **040**（`MIGRATION_CONVENTION.md:7` 已正确写 `supabase/migrations/`） |
| D2 | `README.md:50` 写 baseline `001 through 031` | 实际到 **040** |
| D3 | `AGENTS.md:56`、`privacy.html:45` 称 AI 密钥**不**服务端持久化 | 已实现 AES-256-GCM 加密持久化（`ai-credentials.ts` + 迁移 `024`） |
| D4 | `README.md:68` Contents **read/write** + Administration read | `privacy.html:62` Contents **Read-only**、未提 Administration（两文档互悖） |
| D5 | README/AGENTS 必需变量未列 `ZEUS_A2A_TOKEN` | A2A 端点实际依赖它（`agent-card.ts:47`） |
| D6 | `reconcile-pr-helper.yml:41` 注释「reconciles every 5」 | 迁移 `033` 已将 pg_cron 改为 `*/30` |
| D7 | — | `supabase/README.md` 多处过时（基线 031、reconcile every 5、next file after 031） |

> 合规风险最高的是 **D3**：隐私政策明确「AI 密钥不存服务端」，而代码已加密持久化 AI 凭据。需法务/产品确认并更新隐私政策措辞，或调整实现以保持「仅会话内」。

---

## 7. 风险汇总与优先级

| 优先级 | 项 | 位置 | 建议 |
|---|---|---|---|
| **P0** | A2A 端点 fail-open 鉴权 | `a2a/agent-card.ts:47-53` | 改为 fail-closed（缺 token 直接 401）；将 `ZEUS_A2A_TOKEN` 补入必需清单 |
| P0 | 文档漂移 D3（隐私政策 vs 实现：AI 密钥持久化） | `privacy.html:45` vs `ai-credentials.ts` | 法务/产品确认并修正隐私政策或实现 |
| **P1** | 限流 / 缓存跨实例失效 | `rate-limit.ts:3`、`github-api.ts:12-13` | 引入共享存储（Supabase/KV）+ IP 维度；或文档明确单实例假设 |
| P1 | drain 无独立锁（仅行状态机） | `workflows-store.ts:574` | 评估 `pg_advisory_lock` 或租约 |
| P1 | RLS 安全态游离于迁移之外 | 0 条 CREATE POLICY | 把 RLS policy 纳入迁移（或明确设计决策并文档化） |
| P1 | 文档漂移 D1/D2/D4/D5/D6 | 见 §6 | 同步 AGENTS/README/privacy/supabase-README 到代码实际（040、supabase/migrations、Contents 权限、A2A 变量、cron `*/30`） |
| **P2** | 静默吞错 `.catch(()=>undefined)` | `[action].ts:85,105,111`、`github/[action].ts:107,113`、`workflows-store.ts:496` | 至少 `console.error`，保留审计链 |
| P2 | bigint id 归一化不一致 | `workflows-store.ts:102,107,642`、`automationActionId:117` | 统一 `String`/`BigInt` 归一，防超 2^53 精度丢失 |
| P2 | CSRF：`Origin` 缺失即放行 | `http.ts:25` | 变更请求强制要求 Origin 存在且匹配 |
| P2 | 账户删除对团队创建者可能因 RESTRICT 失败 | `023` 迁移 `created_by` | 删除前先清理团队所有权；或改级联策略 |
| P2 | `main.ts` 关键逻辑缺单测 | `overview`/`render`/对话框 | 补单测，尤其看板筛选计数与投影解析 |
| P3 | 迁移 `030:46` 硬编码生产 URL | `030_*.sql:46` | 改为环境变量/配置 |
| P3 | 死列 `workflow_versions.snapshot` / `workflow_runs.stage_snapshot` | `015` | 确认无读者后清理 |
| P3 | 健康探针对局部降级不敏感 | `reconcile.yml:77` | Job Summary 暴露 degraded 计数 |
| P3 | `.env.local` 含真实 OIDC token（已 gitignore） | `.gitignore:10` | 本地清理或一次性作废 |

---

## 8. 结论

PR Helper 在**架构清晰度、安全基座、迁移规范、测试覆盖**上都达到了较高水准，是一个工程成熟度不错的生产系统。当前最值得投入的三件事：

1. **关闭 A2A fail-open 鉴权**（一行改为 fail-closed，高收益低风险）。
2. **修正文档漂移**，尤其是隐私政策与实现关于「AI 密钥持久化」的直接冲突（合规红线）。
3. **补齐分布式短板**：限流/缓存跨实例失效与 drain 无独立锁，在开始多实例或高并发前需解决；RLS 安全态应纳入迁移治理。

其余 P2/P3 为工程卫生项，可排入常规迭代。
