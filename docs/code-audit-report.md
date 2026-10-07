# PR Helper · 项目级代码审计报告

> 本版审计日期：2026-10-08（分支 `feature/20260722`，HEAD `1038b415`，工作树含 PR 引用复制功能改动）
> 前次审计：2026-09-30。本版为**增量复核**：新增两项 P0、修正前版若干已被修复或不准的结论，前版独有发现全部保留。差异见 §0.1。
> 审计范围：整个仓库（前端 `src/`、服务端 `api/`、数据库迁移 `supabase/migrations/001–040`、CI/CD `.github/workflows/`、公共资产 `public/`、E2E `e2e/`）。
> 审计方法：静态源码审查 + 4 个并行子代理分域深挖（API 层 / 数据库层 / 前端层 / 安全·合规·CI·运维），关键结论逐条回读源码复核；标 ✅ 的条目已直接确认。
> 重要前提：本文基于**源码静态审计**，未执行运行时 / 渗透测试。需线上验证的结论集中在 §9，不要当作已确认事实使用。
> 验证基线（本版实测）：`npx tsc --noEmit` 0 错误 · `npm test` 33 文件 / 716 用例全绿 · Playwright `e2e` 30/30 通过（真实 Chromium）· `npm run build` 通过（JS 261.40 kB / gzip 74.86 kB，CSS 73.75 kB / gzip 13.35 kB）

---

## 0. 执行摘要

PR Helper 是一个 **GitHub-first 的 PR / 发布控制塔**：用 GitHub App 授权，通过 Webhook + 定时对账（reconciliation）驱动真实 PR/部署工作流，覆盖多仓库、多阶段、动态源规则、汇聚门禁、自动化队列、团队 RBAC 与确认式 Production 回滚。

**整体评价**：架构分层清晰，迁移纪律与主题 token 体系属于高水准实践；凭证边界基本守住（App 私钥、installation token、AI key 明文均不出服务端）；纯函数层测试覆盖扎实。但**认证归属校验、数据库租户隔离、测试有效性**三处存在上线级缺陷，且它们互相放大——隔离全靠应用层的 `WHERE user_id`，而那批代码恰恰没有被执行过。

前版「安全基座扎实」的结论应下调：**认证链上存在一条完整的跨租户读取路径（P0-1），且它不在任何测试的射程内。**

| 严重度 | 数量 | 分布 |
|---|---|---|
| P0 阻断 | 4 | 认证归属 1、加密边界 1、数据库隔离 1、测试有效性 1 |
| P1 重要 | 19 | 后端 8、数据层 5、前端 3、CI/CD 3 |
| P2/P3 | 16 | 全域 |

### 0.1 与 2026-09-30 版的差异

**本版新增（前版未覆盖）**

| 项 | 说明 |
|---|---|
| P0-1 `installation_id` 混淆 | 完整跨租户读取攻击链，见 §2.1 |
| P0-4 源码文本伪测试 | 对账 / Webhook 投影只被断言源码字符串，见 §7 |
| Webhook 先读流后验签、无事件白名单、错误全压 401 | §2.3 |
| PR 投影不带 `installation_id` → 租户串写 | §2.2 |
| 团队路由校验可被对象形式 `head` 绕过 | §2.2 |
| 每次 inbox 对同一用户行 11 次 UPSERT | §2.4 |
| CI 不做类型检查、部署不被测试门禁、Cloudflare `VITE_AUTH_ORIGIN` 无校验 | §5.1 |
| 数据保留覆盖不足 + 清理谓词缺索引 + drain 索引不匹配 | §3.3 |
| 预检入口 URL 可能 404 | §4.3 |
| 前端属性位漏转义、链接无 scheme 白名单、7 个幽灵依赖、单 chunk 首屏 | §4 |
| A2A 对外契约文档写错端点 | §6 |

**本版修正前版结论**

| 前版 | 本版核实 |
|---|---|
| D1 `AGENTS.md` 写 `db/migrations/`、基线 031 | **已修复**：现为 `supabase/migrations/` + `001–040` ✅，D1 撤销 |
| D2 `README.md:50` 基线 031 | **已修复**：现写 `001 through 040` ✅，D2 撤销 |
| 「`workflows-store.ts` 6000+ 行」 | 实为 **2,964 行** ✅ |
| 「main.ts 顶层约 80 个 `let`」 | 实测 **69 处**列 0 `let` ✅ |
| 「e2e 共 31 个 test」 | 实测 **30 个** ✅ |
| 「已配 CI 单测 + 浏览器 E2E」 | 事实成立，但 **e2e 不在 CI 中运行**，且单测对核心状态机为文本断言（§7） |

**前版保留（本版复核仍成立）**：CSRF `Origin` 缺失即放行、限流/缓存跨实例失效、drain 无独立锁、bigint 归一化、静默吞错、死列 `snapshot`、迁移 030 硬编码生产 URL、健康探针对降级不敏感、`.env.local` OIDC、D3–D7、加密 blob `v2:keyId:salt:iv:ciphertext`、PR 草稿上限 50、`src` 19 个测试文件。

---

## 1. 技术栈与架构

| 层 | 技术 | 说明 |
|---|---|---|
| 浏览器 | Vite + 原生 TypeScript（**无 React/Next**） + CSS | 看板、对话框、AI 流式、本地持久化 |
| API | Vercel Serverless Functions（`api/**/*.ts`） | 文件路由 + 处理函数内二次分发 |
| 认证/集成 | GitHub App OAuth + 签名 HttpOnly 会话 + 短生命周期 Installation Token | 密钥全在服务端 |
| 持久化 | Supabase Postgres（`DATABASE_URL`） | 唯一事实来源是 `supabase/migrations/001–040`，26 张表 |
| 监控 | GitHub Webhook + 定时对账 + 收敛健康探针 | Web Push（web-push + Service Worker） |
| 测试 | Vitest（单元）+ Playwright（浏览器 E2E，端口 4373） | `npm test` / `npm run test:e2e`（后者不进 CI） |
| 部署 | Vercel（canonical 安全 API）+ Cloudflare Pages（静态镜像） | 双平台各自构建，见 §5.1 |

**关键常量（部分）**：会话 7 天、限流 60s/60 次、连接池 `max:4`、对账预算 webhook 8000ms / inbox_refresh 6000ms / cron 40000ms、收敛阈值 45min（生产经 env 调至 9000s）、阶段陈旧 15min、加密同步 blob 上限 2 MB。

**规模**：`src` 12,027 行（TS 8,934 + CSS 3,093）、`api` 8,666 行；最大单文件 `src/main.ts` 3,189 行、`api/_lib/workflows-store.ts` 2,964 行。

---

## 2. 服务端 API 层审计

**入口清单**

| 路由 | 文件:行 | 职责 |
|---|---|---|
| `DELETE /api/account` | `account.ts:5` | 删除账号、清 session |
| `GET/POST /api/<action>`（inbox/recovery-event/rerun-actions/deployment-rollback/repair-context/preflight） | `[action].ts:133` | 收件箱投影、失败恢复、重跑、回滚、修复上下文、预检 |
| `GET/PUT/PATCH/DELETE /api/workflows`（resource: ai-credentials/automation/teams） | `workflows.ts:25` | 工作流 CRUD、AI 凭据、团队、自动化入队 |
| `GET/POST /api/encrypted-sync` | `encrypted-sync.ts:10` | 端到端加密云同步（密文仅存） |
| `GET /api/auth/github/<action>` | `auth/github/[action].ts:94` | OAuth 登录全流程、安装绑定、登出 |
| `GET/POST/PUT /api/github/<action>` | `github/[action].ts:122` | 会话探针 + **代理** GitHub REST |
| `POST /api/github/webhook` | `github/webhook.ts:17` | 接收 Webhook（raw body + 验签） |
| `GET/POST /api/notifications/<action>` | `notifications/[action].ts:35` | Web Push 公钥与订阅 |
| `GET /api/cron/{drain,health,reconcile}` | `cron/*.ts:10` | 排空 / 健康探针 / 定时对账 |
| `GET/HEAD/POST /api/a2a/agent-card` | `a2a/agent-card.ts:35` | Agent Card + A2A JSON-RPC |

> 注：`request-protection / csrf / validation / audit / encrypted-sync / installation-token` 并非独立文件，而是内联在 `http.ts / github-app.ts / workflows-store.ts / push.ts / github-api.ts` 中。
> `.vercelignore` 显式排除 `*.test.ts`，避免测试文件被发布成 Serverless 路由——设计正确，但靠人工维护，CI 无回归防护。

### 2.1 P0-1 认证归属：`installation_id` 混淆 → 跨租户读取 ✅

`api/auth/github/[action].ts:74-87` 的 `installation()` 直接接受 query 中任意 `installation_id`，只用 App JWT 调 `/app/installations/{id}` 确认该安装**存在**，**从不校验 `installation.account.login` 是否等于当前 session 的 login**，随后把这个 ID 签进 7 天 session cookie。

对照同文件 `:58-72` 的 `install()`：它用的是**正确**的 `installationForLogin(...)`。同一模块内一条路径正确、一条不校验，说明是遗漏而非设计。

攻击链：
1. 已登录用户访问 `/api/auth/github/installation?installation_id=<他人安装 ID>`；
2. `api/github/[action].ts:99` 用该 installation token 代理白名单 GET，包含 `/installation/repositories`（该安装下**全部**私有仓列表）、`/repos/{o}/{r}/pulls`、check-runs；
3. `api/_lib/workflows-store.ts:1008` 以 `COALESCE` 把该 ID 写进 `pr_helper_users.github_installation_id`，污染持久化状态。

共享 GitHub App 下所有租户的私有仓元数据互相可达，且绕过全部 workflow 归属检查。**可利用性取决于该 App 是否公开可安装**（§9-3）。

**修复**：`installation()` 复用 `installationForLogin` 比对 login；并把 `install → installation` 的跳转改为服务端一次性 state 绑定，而不是让客户端回传 ID。

### 2.2 授权与租户边界（其余）

- 用户/权限：`userForLogin:1006`、`workflowAccessForUser:1387`、`requireWorkflowOperation:1410`、`visibleWorkflowPredicate:1417`（对**静态列名**用 `sql.unsafe`，值均参数化——未见注入）。
- **P1 租户串写**：`projectPullRequestWebhook`(`workflows-store.ts:1763`) 仅按仓库全名匹配工作流，**不带 `installation_id`**（对照定时扫描 `:2454` 是带过滤的）；根因是 `upsertWorkflow:1634-1638` 从不校验 `workflow.repository` 是否属于调用者的 installation。A 的 webhook 可写入 B 的门禁状态并驱动其自动化队列。
- **P1 团队路由校验可绕过**：`api/github/[action].ts:39-44` `pullRequestBranches` 只认字符串 `head`/`base`；GitHub 允许 `head:{label,sha}` 对象形式，此时 source/target 为 undefined，`workflows-store.ts:1450` 的路径一致性检查整体跳过 → 共享仓库下可在任意分支对开 PR。
- GitHub 代理白名单：`github/[action].ts:46 isAllowedGithubRequest`（路径+方法）+ `authorizeWorkflowOperation:1446` 团队角色校验 ✅；但白名单项 `/branches/[^?]+` 的 `[^?]+` 可吞 `/`（P2）。
- 账号删除：`workflows-store.ts:2959-2964` 只 `DELETE FROM pr_helper_users` ✅，而 `023_team_permissions.sql:18,34` 的 `created_by`/`shared_by` 是 `ON DELETE RESTRICT` ✅ → **建过团队或共享过流程的用户必然删除失败**，`api/account.ts:17` 返回 400 + 原始 FK 文案。隐私政策的删除承诺不成立（前版列为 P2，本版因已确认 RESTRICT 升为 **P1**）。

### 2.3 Webhook 与请求保护

- 签名：`x-hub-signature-256` + `timingSafeEqual` ✅；重放防护仅靠 `delivery_id` 唯一索引（`workflows-store.ts:1754`），30 天保留后同签报文可再次受理，且未校验 `x-hub-signature-timestamp`（P2）。
- **P1 先读后验**：`api/github/webhook.ts:5` `bodyParser:false` + `:9-12` 手工累积整个流，**无尺寸上限**，验签在读完之后 → 未验签流量即可耗尽函数内存。
- **P1 错误全压 401**：`api/github/webhook.ts:43-44` 单个 `catch` 把 JSON 解析失败、DB 抖动都写成 401 → GitHub 按永久失败处理并重试放大。
- **P1 无事件白名单**：`workflows-store.ts:1339-1343` `webhookCanChangeStageState` 除 `check_run.created` / `workflow_run.in_progress` 两个特例外对**任意事件名返回 true**，`webhook.ts:34-41` 据此内联触发全量 reconcile。
- CSRF：`http.ts:23-34`（保留前版）⚠️ `!origin` 时直接放行（`:25`），且 `SameSite=Lax` 下顶层表单 POST 可绕过。
- 限流：`rate-limit.ts:7` 滑动窗口 60s/60 次，key = `login:action`。⚠️ 进程内 `Map` **永不淘汰**（只有测试用的 `resetRateLimitsForTests` 会 clear）✅，且 key 含攻击者可控的 `query.action` → 单账号可无限制造桶；serverless 分片使实际上限 ≈ 60×实例数。所有 `/api/workflows` 子资源因无 `action` 塌陷成同一 `'request'` 桶，与 GitHub 代理互抢配额。
- 幂等/并发：入队靠 DB 唯一约束 `(user_id, idempotency_key)` ✅；执行器 `UPDATE … WHERE state='queued' RETURNING` 乐观 claim ✅；drain 无独立锁（保留前版 P1）。

### 2.4 性能与错误契约

- **P1 读放大**：`api/[action].ts:52` 并行 11 个 store 调用，每个独立执行 `userForLogin` 的 UPSERT（`:1006-1010`），`VisibleWorkflowReads` memo（`:1429-1444`）只缓存 SELECT 不缓存这个写 → **每次 inbox 轮询对同一用户行做 11 次 UPSERT** 并产生行锁竞争。
- **P1 错误契约靠中文字符串匹配**：`api/_lib/http.ts:36-44` 用 `error.message` 文案判状态码；原始 message 直送浏览器（`api/[action].ts:55,118`、`webhook.ts:44`），`api/workflows.ts:14-18` 还会泄露迁移文件路径。
- `isStoredWorkflow`(`:1276-1289`) 校验形状但无 `stages.length` / 字符串长度上限；`api/workflows.ts:81-93` 接受大 payload 后在 60s 函数内做全删全插(`:1462-1472`) 与逐行 DELETE 循环(`:1474-1481`)。
- 可观测性：全 `api/` 仅 7 处 `console.*`，且只在 `workflows-store.ts`；入口处理函数无请求 ID、无错误日志（P2）。
- **SSRF**：`validateAiBaseUrl`(`api/_lib/ai-credentials.ts:6-12`) 漏 `169.254.0.0/16`、`100.64.0.0/10`、`172.17-31.*`、十进制/短格式 IP，且 `src/lib/ai.ts:11-14` 未设 `redirect:'error'` → 出站请求可被重定向到内网（缓解：强制 https）。

### 2.5 A2A 模块

Agent Card + JSON-RPC（`tasks/send`、`sendSubscribe`、`get`、`cancel`）+ SSE。

- **P0-2 fail-open** ✅：`api/a2a/agent-card.ts:47-48` `if (expected && token !== expected)`，`ZEUS_A2A_TOKEN` 缺失时整个 JSON-RPC 面匿名可用，无生产环境启动断言；`docs/a2a-vassal.md:11` 明确写了这一行为，属设计而非笔误。**当下缓解**：`api/_lib/a2a/skills.ts:36-41` `credentialRequired()` 让 `mode:'execute'` 恒返回 `input-required`，即只产 plan 不执行 GitHub 动作，所以泄露面限于流程信息与 DoS 面；一旦委派凭据落地即成远程命令面。
- **P1 任务态在实例内存**：`api/a2a/agent-card.ts:18` + `task-store.ts:3-13`（500 条 / 30 分钟），冷启动与多实例下 `tasks/get`/`tasks/cancel` 必然 `TASK_NOT_FOUND`；`rpc.ts:75-80` 先 create 后执行，无按调用方的隔离键。
- **P2 夸大声明**：`agent-card.ts:71-81` 声称 SSE，但 `executeTask` 同步完成、事件一次性刷出；卡片 `api/_lib/agent-card.ts:56` 的 `streaming: true` 与之呼应。`rpc.ts:53-58` 把 text part 的首个空白 token 当 skill id。
- CORS `*`、body 无尺寸上限（P1/P2）。

### 2.6 凭证与加密边界（结论：设计正确）

- AI 凭据：仅以 AES-256-GCM 密文 + 8 hex sha256 hint 存 `pr_helper_ai_automation_credentials`（`workflows-store.ts:53-57`），`getAiAutomationCredential:43-51` 只回 `keyMask`（前 3 后 4）与 hint，**明文不出服务端**，仅 `readAiAutomationCredentialForUser:73-77` 解密供自动化使用 ✅。
- 加密同步：2 MB 上限(`:2825`)、scope 白名单、`expectedRevision` 乐观锁 + `FOR UPDATE`(`:2832-2837`)、30 天历史回收(`:2870`)，读写均以 `user_id` 为键，未发现越权路径 ✅。
- App 私钥、client_secret、会话密钥、Installation Token、Webhook Secret、CRON_SECRET、ZEUS_A2A_TOKEN 均不出浏览器；`/api/github/session` 仅回登录态 ✅。

### 2.7 结构性问题

`api/_lib/workflows-store.ts` 2,964 行承载至少 8 个互不相干的限界上下文：AI 凭据(`:40-111`)、自动化队列与排空(`:84-635`)、Webhook 投影(`:1339-1361,1752-1772`)、工作流读写与访问控制(`:1276-1750`)、对账(`:1955-2505`)、遥测与投影读(`:2511-2820`)、加密同步(`:2810-2850`)、团队与账号(`:2886-2964`)。可验证的耦合代价：`userForLogin` 被 40+ 个导出函数各自调用，`VisibleWorkflowReads` memo 只覆盖 2 个查询。**建议按限界上下文拆分**——拆分之一（对账）同时也是测试最难补的地方（§7）。

---

## 3. 数据库与持久化层审计

### 3.1 数据模型（26 张表，按功能分组）

- 用户/团队：`pr_helper_users`(001)、`pr_helper_teams`(023)、`pr_helper_team_members`(023)、`pr_helper_team_workflows`(023)
- 工作流：`pr_helper_workflows`(001，payload 仍为真源；036/038 提升列 name/repository/archived/version 为 NOT NULL)、`pr_helper_workflow_stages`(036 关系化镜像)、`workflow_versions`(015)
- 阶段状态：`workflow_stage_states`(004→019 主键演进为 `(user_id,workflow_id,stage_id,source)`)、`workflow_stage_events`(008)、`workflow_runs`(015)
- 部署：`workflow_stage_deployments`(010)、`workflow_stage_deployment_runs`(013)、`workflow_deployment_configs`(036)
- 监控/事件/Webhook：`github_webhook_deliveries`(003→017)
- 通知：`pr_helper_push_subscriptions`(006)、`pr_helper_notification_deliveries`(006)
- 审计：`workflow_operation_audit_logs`(020，不可变、8 种 action CHECK、`workflow_id` 仅 text 无 FK)
- 自动化：`workflow_automation_runs`(025)、`workflow_automation_actions`(025)、`pr_helper_ai_automation_credentials`(024,026)
- 对账：`reconciliation_runs`(014→032)、`reconciliation_leases`(028)、`data_retention_runs`(022)
- 加密同步/生成规则：`pr_helper_encrypted_sync`(016)+`history`(021)、`pr_helper_generation_rules`(035,040)

**演进脉络**（读迁移可得，设计意图连贯）：017 按用户/installation 收窄遥测 → 018/019 两步（加列→回填→切主键）把位置型 `stage_index` 换成稳定 `stage_id` → 022 数据保留 → 023 团队 → 024-026 AI 自动化 → 027-033 对账连续止血（会话级 advisory lock 曾冻结实例 8.7 分钟 → 行租约 → 轮转公平 → pg_cron 时钟 → 成本/相位遥测）→ 034-040 payload 关系化（expand/backfill/read-switch/contract）。

### 3.2 迁移规范（良好，但有例外）

全文搜索 `CREATE/ALTER/DROP TABLE|INDEX|EXTENSION` 在 `workflows-store.ts` 中 0 命中（无运行时 DDL）；序号 `001–040` 连续无跳号；每个变更都是新增文件，不改写已应用迁移。

例外（P2）：019 `:31-44` 五表 `SET NOT NULL`、`:46-71` `DROP CONSTRAINT` + `ADD PRIMARY KEY`（非 CONCURRENTLY，ACCESS EXCLUSIVE 全程阻塞）、009 `:16-17` 同类 PK 交换；017/027 反复 DROP+ADD 同名 CHECK（存在约束缺失窗口）；仅 037 有显式事务，规范不统一。7 表用 `bigserial`（Supabase 最佳实践推荐 IDENTITY）、10 表随机 uuid v4 PK；`pr_helper_workflows.id` 为客户端 text 无 CHECK，`payload` 无 `jsonb_typeof='object'` CHECK（002 只修数据未补约束）→ 解析失败即静默丢行（`workflows-store.ts:1567,2519`）。

`tools/check-migrations.sh`（本仓迁移规范检查器，实测 40 文件 39 warning）**未被 CI / package.json / 任何文档引用**（P2）。

### 3.3 性能、增长与索引

- 大 JSONB 热点：`pr_helper_workflows.payload`（35 行≈70.8 kB，曾单次 inbox 被 5 个 list 各读一遍=354 kB/588 kB）。Egress 优化后单次 594→274 kB、前台 71→16.4 MB/小时（−94%）。
- **P1 保留覆盖不足**：`workflows-store.ts:2854` + `022:14` 只清 6 张表；无界增长的是 `workflow_versions`(015:13，每次保存整份 jsonb 快照)、`workflow_runs`(015:25)、`workflow_automation_runs.workflow_snapshot`(025:23)、`workflow_automation_actions.payload`（每条 create-pr 内嵌整份提示词全文，160→108）、`pr_helper_notification_deliveries`(006:25)、`data_retention_runs` 自身。**040 刚花两步从 payload 删掉的提示词副本，被自动化队列原样写回。**
- **P1 清理谓词缺索引**：`workflows-store.ts:2869-2874` 六个 `WHERE <时间列> < cutoff LIMIT 2000`，只有 `reconciliation_runs(finished_at)`(014:25) 有索引；其余 5 张表的时间索引前导列是 `installation_id`/`user_id` → 每 30 分钟 5 次全表扫。
- **P1 drain 谓词与索引不匹配**：部分索引 `025:53-55` 为 `WHERE state IN ('queued','running')`，查询 `workflows-store.ts:447` 含 `'paused'` 且 `:448` 按 `(state='paused')` 排序 → 索引不可用；`:436-443` 两个关联子查询需要的复合索引不存在。队列本身无清理，代价随历史线性上升。
- **P1 FK 未建索引**：`workflow_automation_actions.run_id`(025:37 CASCADE)、`pr_helper_teams.created_by`(023:18 RESTRICT)、`pr_helper_team_workflows.shared_by`(023:34 RESTRICT) → 删用户/删 run 时锁表全扫（这正是 §2.2 删除失败路径的放大项）。
- P2：`reconciliation_runs` 缺 `(state,started_at)`（`:2442` 僵尸回收）与 `(trigger,started_at)`（`:2742` 收敛健康）索引；`:2704` 的 `ORDER BY started_at` 与 017 索引列序不符；已 settled 阶段每轮 `UPDATE … SET updated_at=now()`（`:2044`）无信息量写；`pruneStaleWorkflowStageData`(`:1474-1480`) 循环内逐条 DELETE 并在 sweep 里串行 await(`:2187`)；enqueue 非事务（`:178-183,204-209`）实例被杀留孤儿 run；冗余索引 018 `:133-140` 与 019 主键逐字重复。
- 连接池：`workflows-store.ts:980` `postgres(url, { max:4, prepare:false })`，单一池（无独立只读池）。

### 3.4 数据一致性

- **P8 bug 已修复**（保留前版）：`workflow_automation_actions` 无 `stage_index` 列（025 只建在 runs 上），曾致动作永久卡 `queued`；现 `execute…:568` 与 `list…:641` 均 JOIN runs 取列，并有静态一致性护栏 `workflows-store.test.ts:688-728`。
- **死列（写了不读）**（保留前版）：`workflow_versions.snapshot`(015:17)、`workflow_runs.stage_snapshot`(015:33) 无 SELECT 读者；`workflow_automation_runs.workflow_snapshot` 为 LIVE。
- **未收尾的过渡态（本版新增）**：`payload` 仍是唯一真相并被 6+ 处全量读取（`workflows-store.ts:1435,1555,1557,2519,2569,2769`，040:34 自陈「14 read sites」），与 `workflow_stages`/`workflow_deployment_configs` **同事务双写**（`:1664-1665`，036:11 自写「payload remains the only truth」）；`stage_index` 仍是 states/events/runs/actions 的写入列并被 `deriveStageDecision`(`:1519-1521`) 用作 `workflow.stages[stageIndex]` 下标，靠 `stage_id` 相等兜底，**失配即静默显示「暂无状态」**；037 `:38` 的 `UPDATE … FROM payload` 与 `:40/:69` 的全表重建属一次性但不可回滚。
- 租约：TTL 30s / 续约 10s，而 cron 预算 40s(`:2322`)，续约失败被 `.catch(()=>undefined)`(`:2160`) 吞掉 → 活 sweep 可被接管、同 scope 双跑（幂等键兜底正确性，但 GitHub 配额翻倍）。租约泄漏本身有界（`:2281` holder 守卫 + `:2876` 过期清理）。

### 3.5 P0-3 数据库层零租户边界，且真实 RLS 状态游离在版本控制外 ✅

40 个迁移里 `ENABLE ROW LEVEL SECURITY`、`CREATE POLICY`、`GRANT`、`REVOKE` **零命中**（全目录 grep ✅）。隔离 100% 在应用层。

而 `docs/supabase-readonly-debugging.md:181-207` 实测生产 `relrowsecurity = true` 且无 policy → **RLS 是在 Supabase 仪表盘手工开启的，不在任何迁移里**，与 `AGENTS.md:41`「迁移是唯一事实来源」直接冲突；同文档 `:198` 的解法是给只读角色 `bypassrls`（万能读钥匙）。

后果：任何一处漏写 `WHERE user_id` 就是静默跨租户泄露，数据库不兜底；且无人能从代码判断线上真实隔离状态。若 PostgREST 仍暴露 `public` schema（Supabase 默认），`anon` 可直接读 `pr_helper_encrypted_sync`、`pr_helper_ai_automation_credentials`、`workflow_operation_audit_logs`、`pr_helper_users.github_login`。

敏感数据本身处理正确（仅密文入库，§2.6 ✅），问题在于**边界只有一层且那一层没有测试**。

---

## 4. 前端层审计

### 4.1 模块与 SoT

`src/lib/` 20 个模块（19 个测试文件 ✅）：`domain.ts`（门禁决策/URL/check 聚合，**SoT**）、`workflow.ts`、`workflow-run.ts`、`navigation.ts`、`i18n.ts`（无单测）、`app-name.ts`、`ai.ts`、`ai-stream.ts`、`workflow-save-queue.ts`、`action-queue-request-queue.ts`、`encrypted-sync.ts`、`pr-drafts.ts`（24h TTL / 上限 50 ✅）、`generation-rules.ts`、`github.ts`（**唯一** GitHub API 边界）、`team-permissions.ts`、`projected-stage.ts`（详情首屏投影 + 30s TTL）、`pr-reference.ts`（新增：PR 引用复制）。

**SoT 违反核对：未发现违反 AGENTS.md 第 1 条**（保留前版）。仅 `dynamicBranchStatusText`、`drawerStatusText` 内联重述 `canMergeOpenPull` 条件（展示级冗余，建议复用）。

### 4.2 结构与状态

`src/main.ts` 3,189 行单模块，无页面/组件边界；**69 处列 0 `let`** ✅ + 约 9 个可变容器 ≈ 78 项全局状态；182 处 `addEventListener` 靠 3 个 `*Bound` 布尔位防重复绑定；每次交互整树 `innerHTML` 重建（38 处赋值、19 处手写 `createElement('dialog')`、20 处 close→remove 样板），焦点/滚动丢失需手写补偿。最长单行近 3,000 字符。

这是**测试难做的直接原因**：任何行为验证都必须从 DOM 反推，于是 e2e 只能桩化后端、单测只能断言源码文本（§7）。

### 4.3 安全与可用性

- **P1 属性位漏转义**：`escape()` 有 92 处调用，文本节点一致，但 `href="${githubInstallationSettingsUrl}"`、`href="${status.pr!.html_url}"`、`<option value="${repo.full_name}">`、`t('sync.prompt.desc',{login})` 等未转义。
- **P1 链接无 scheme 白名单**：`payload.pullUrl`、`runUrl/deploymentUrl/failureJobUrl` 只 `escape()` 即可保留 `javascript:`。（本次新增的 PR 复制 chip 不受影响：URL 由 `githubPullUrl()` 硬编码 `https://github.com/` 前缀生成。）
- **P1 i18n 破口**：浏览器侧 lib 硬编码中文直达 UI —— `generation-rules.ts:142`、`github.ts:18,52,57`、`ai-stream.ts:310-347`、`team-permissions.ts:21-35`、`encrypted-sync.ts:75,139-140,165,171`，EN 用户会看到中文。
- **P1 预检入口疑似 404**：`src/main.ts:1243` 请求 `/api?action=preflight`，路径是 `/api`，而路由文件 `api/[action].ts` 匹配 `/api/:action`，`api/index.ts` 不存在 ✅，`vercel.json` 四条 rewrite 也不覆盖 `/api`；同文件其余调用一律用 `/api/inbox` 形式。**需线上验证**（§9-1）。
- P2：`confirmDialog()` 五个参数全不转义，安全性依赖调用方自觉（现有 3 个调用方恰好都做了）；类名从服务端枚举字符串裸插值（`${deployment.state}`、`pf-${check.severity}`）；`repositoryManagementTimer` 500ms `setInterval` 仅在 popup 关闭时 clear，导航离开不清。

### 4.4 依赖与构建

- **7 个运行时零引用依赖** ✅：`react`、`react-dom`、`next`、`tailwindcss`、`postcss`、`autoprefixer`、`eslint`（另有 `@types/react`、`@types/react-dom` 随之多余）。全仓 `.ts/.tsx/.js/.mjs/.cjs/.css/.html` 对这些包名**零 import**；仓库无 `vite.config.*`、无 tailwind/postcss/eslint 配置文件。
- `npm run lint` 实际执行 `vite build --emptyOutDir`，命名误导（且 esbuild 只剥类型，见 §5.1）。
- **无 vite 配置 → 零分包**：单 chunk 全量首屏，JS gzip 74.86 kB、CSS gzip 13.35 kB（本次实测），无 vendor 分离、无 manualChunks、无 preload。
- `style.css:1` 用 CSS `@import` 拉第三方字体，串行阻塞且无 `preconnect`；`index.html:2` 硬编码 `lang="zh-CN"` 而默认 locale 是 `en`，无 meta description。
- **主题 token 体系是全仓最好的实践**（保留并强化前版结论）：75 个 `:root` token + 完整 dark 覆写，`style-theme-tokens.test.ts` 6 条守卫（变量必须可解析、禁字面 fallback、禁 `--bg-*` 当文字色、dark 必须覆盖全部 light token、dialog 文字色、部署行按钮各占一列）。
- 死代码：`app-name.ts`（仅自测）、`domain.ts getStageAction` + `StageInput`、`workflow-save-queue.ts whenIdle/hasPendingEdits`、`encrypted-sync.ts getCloudSyncKeyId`/`rotateCloudSyncKey`(仅别名)、`workflow.ts deploymentConfigsForTarget`（服务端另有私有副本）、`main.ts executeAutoCreatePr`（无调用方）。

### 4.5 看板筛选语义（保留前版，本版复核成立）

状态 `'all'|'attention'|'running'|'failed'|'automation'|'archived'`；`需要处理(attention) ⊆ 正在运行(running)`（真子集）；「第 N/总计 步」由 `laneRunSummary` → `overview.run.current` 渲染。

---

## 5. 安全 / 合规 / CI-CD / 运维审计

### 5.1 CI/CD（5 个 workflow）

- `ci.yml`：PR + push(dev/main)，步骤 `npm run lint` → `npm test` → `npm run build`，`cancel-in-progress` ✅。
- **P0 级门禁缺失（本版新增）**：
  - **CI 不做任何类型检查** ✅：无 `vite.config.*`，`lint` 即 `vite build`（esbuild 剥类型），`build` 入口只有 `index.html → src/main.ts`，**`api/` 全部不进构建**，CI 无 `tsc --noEmit`（而 `AGENTS.md:25`、`README.md:32` 把它写成人工动作）→ `api/` 约 5.2k 行的类型错误 CI 永不发现（当前恰好干净）。
  - **部署不被测试门禁** ✅：`ci.yml` 与两个 deploy workflow 都在 `push: dev/main` 独立触发，无 `needs:` / `workflow_run:` → 单测红的提交照样直上 production。
  - CI 把 vite build 跑两遍（`lint` + `build`），纯浪费。
  - **e2e 完全不进 CI**：`ci.yml` 无 Playwright 步骤，30 个浏览器用例只在本地。
- **P1 双平台不同构（本版新增）**：`deploy-cloudflare-pages.yml:29-30` 注入 `vars.VITE_AUTH_ORIGIN` 且**无存在性校验**，`src/lib/github.ts:2` 缺失时回落空串 → 镜像把 `/api` 打到 Pages 自身（无 API），静默产出坏站；`deploy-vercel.yml` 根本不传该变量，两平台构建产物来源不同构。
- `reconcile-pr-helper.yml`：缺 `PR_HELPER_CRON_SECRET` 时 `exit 0` + warning（`:36`）→ **绿灯但零对账**（fail-open）；该 workflow 无 `concurrency:` 块（另 4 个都有）；三个 URL 硬编码 `pr-helper-ten.vercel.app`，`workflow_dispatch` 从任意分支都会打生产端点；`*/10` 兜底已被自陈实测中位数拖到 46 分钟（与 030 头部一致），现 `SWEEPS=1` 单扫，重入靠 DB 租约。
- `rollback-frontend-deployment.yml`：**确认可执行且有真门禁** ✅（本版复核）——仅 `workflow_dispatch`、三输入 required、job 绑定 `environment:`、脚本校验 run 为 `success` + `name` 匹配 + `head_branch==main` + `https` + `*.vercel.app`/`*.pages.dev` 后缀 + 仅 production。人工确认只依赖 Environment 审批规则（不可静态确认）。
- `vercel.json`：`functions."api/**/*.ts".maxDuration = 60`；4 条 rewrite（`/api/ai-credentials`、`/api/automation`、`/.well-known/agent-card.json`、`/agent.json`）。

### 5.2 安全机制对照表

| 机制 | 位置 | 评价 |
|---|---|---|
| 安装归属校验 | `auth/github/[action].ts:74-87` | ❌ **P0-1 不校验 login 即签发** |
| CSRF/来源 | `http.ts:23-34` | ⚠️ `Origin` 缺失即放行 + `SameSite=Lax` 顶层表单 POST 可绕过 |
| 会话 | `github-app.ts:94-111` | HMAC+`timingSafeEqual`，HttpOnly+Secure+Lax，7 天 ✅；**无吊销**（`logout:89-92` 只清客户端，被窃 cookie 有 7 天全权，唯一手段是轮换全局 `AUTH_SESSION_SECRET`） |
| 限流 | `rate-limit.ts` + `session.ts:15-19` | ⚠️ 进程内 Map、永不淘汰、key 含可控 action、无 IP、跨实例失效 |
| 幂等/并发 | `workflows-store.ts:2824` / `webhook.ts:29` | 乐观锁 + 去重 ✅ |
| GitHub 代理白名单 | `github/[action].ts:46` | 路径+方法 + 团队授权 + 审计 ✅；`/branches/[^?]+` 过宽 |
| Webhook 签名 | `webhook.ts:20-24` | `timingSafeEqual` ✅；先读流后验签 ❌、无事件白名单 ❌ |
| 审计 | store 层 + 代理变更 | 较全；**缺口**：`DELETE /api/account` 与 encrypted-sync save 未显式审计 |
| A2A 鉴权 | `a2a/agent-card.ts:47-53` | ⚠️ **fail-open** |
| cron 端点 | `cron/*.ts:7` | ⚠️ 允许 `cron-secret` cookie 通道，且用 `===` 非常数时比较；GET 会由浏览器自动携带 Cookie |
| SSRF | `ai-credentials.ts:6-12` | ⚠️ 私网段覆盖不全，前端未禁 redirect |

### 5.3 合规与隐私

- 隐私政策 `public/privacy.html`：收集 GitHub 登录/ID/头像、流程配置、监控数据；localStorage 本地数据；服务端 Supabase(AWS)；加密云同步零知识；**不收集私钥/安装令牌/AI 密钥/分析 Cookie/IP**；第三方 GitHub/Vercel/Cloudflare/Supabase。
- **P1 删除承诺不成立**：见 §2.2（`023` RESTRICT × `deleteAccount` 单表 DELETE）。
- 数据保留：`RETENTION_DAYS` = webhook 30 / syncHistory 30 / reconciliation 90 / stageEvents 180 / deploymentRuns 180 / audit 365 天，cron 分批清理 ✅；但覆盖表不全（§3.3）。
- Cookie：仅功能 Cookie，无追踪 SDK，GDPR 下可豁免同意横幅 ✅。

### 5.4 密钥管理（必需环境变量）

GitHub App（`GITHUB_APP_*`）、`GITHUB_WEBHOOK_SECRET`、`AUTH_SESSION_SECRET`、`APP_ORIGIN`/`CSRF_ALLOWED_ORIGINS`、`DATABASE_URL`、`CRON_SECRET`（来自 `PR_HELPER_CRON_SECRET`）、`VAPID_*`、`AI_CREDENTIALS_ENCRYPTION_KEY`(32B)、`ZEUS_A2A_TOKEN`（⚠️ 文档未列）、部署 `VERCEL_*`/`CLOUDFLARE_*`。全仓搜索 `sk-/ghp_/eyJ/` **0 命中**（无硬编码密钥）；`.env.local` 已 gitignore ✅（`coverage/`、`test-results/`、`dist/`、`.codegraph/`、`.playwright-cli/` 同样未进库 ✅）。

进库杂项（P2）：`.agents/skills/` 40 个第三方 skill 文件、`.trae/rules/` 4 个、`.claude/` 配置、根级近 92 kB 的 `handoff.md`。

### 5.5 双平台与运维（保留前版，仍成立）

Vercel=canonical 安全 API + Cookie 签发；Cloudflare Pages=静态镜像，`VITE_AUTH_ORIGIN` 指向 Vercel；CF 因 `SameSite=Lax` 无法保持登录态写入，授权后跳回 Vercel。⚠️ **prebuilt 约束**：生产是 Actions 上传的 prebuilt 产物，面板 Redploy 会被拒，改 env 后须 `gh workflow run deploy-vercel.yml --ref main`。实验变量 `REALTIME_RECONCILE_BUDGET_MS` 若残留会覆盖新常量，部署前须 `vercel env rm`。

可靠性：pg_cron + pg_net 为主时钟（drain `*/2`、reconcile `*/30`）；`/api/cron/health` 仅对未归档 workflow 计数，最老投影超阈值返 503；预算让出记 `degraded` + 置 `reconcile_pending_since` 由 webhook/cron 接力。⚠️ 健康探针对局部降级不敏感（`reconcile.yml:77` 自陈 degraded 仍返 200）。

---

## 6. 文档漂移专项（代码 vs 文档）

| # | 文档说法 | 实际（证据） | 状态 |
|---|---|---|---|
| D1 | `AGENTS.md` 写 `db/migrations/`、基线 031 | 现为 `supabase/migrations/` + `001–040` ✅ | **已修复，撤销** |
| D2 | `README.md:50` 基线 031 | 现写 `001 through 040` ✅ | **已修复，撤销** |
| D3 | `AGENTS.md:56`、`privacy.html:45` 称 AI 密钥**不**服务端持久化 | 已实现 AES-256-GCM 加密持久化（`ai-credentials.ts` + 迁移 024） | ⚠️ **仍冲突（合规红线）** |
| D4 | `README.md:68` Contents **read/write** + Administration read | `privacy.html:62` Contents **Read-only**、未提 Administration | ⚠️ 两文档互悖 |
| D5 | README/AGENTS 必需变量未列 `ZEUS_A2A_TOKEN` | A2A 端点实际依赖它（`agent-card.ts:47`） | ⚠️ 未修 |
| D6 | `reconcile-pr-helper.yml:41` 注释「reconciles every 5」 | 迁移 `033` 已改 `*/30` | ⚠️ 未修 |
| D7 | `supabase/README.md` 多处过时 | 现 `:9` 已写 `001…040` ✅ | **部分已修复** |
| **N1** | `current-state.md:21,125,378` 写 31 文件 / 691 测试 | 实测 **33 文件 / 716 测试** ✅ | 新增，未修 |
| **N2** | `docs/a2a-vassal.md:9,57,63` 声明任务端点 `POST /api/a2a/tasks`（`api/a2a/tasks.ts`） | 该文件不存在，实际挂在 `POST /api/a2a/agent-card`（`api/_lib/agent-card.ts:108` 自认） | 新增，**对外契约错误**：照文档实现的 Zeus 客户端全部 404 |
| **N3** | README/AGENTS 能力清单 | **零**提及 A2A（6 文件 696 行）、团队权限（迁移 023）、数据保留（022）、pg_cron 时钟（030） | 新增，未修 |
| **N4** | `AGENTS.md:35` 称 `encrypted-sync.ts` 是 skeleton | 174 行完整实现 + 迁移 016/021 | 新增，未修 |

> 合规风险最高的仍是 **D3**：隐私政策明确「AI 密钥不存服务端」，而代码已加密持久化 AI 凭据。需法务/产品确认并更新隐私政策措辞，或调整实现。
> 对外集成风险最高的是 **N2**：这是唯一一个会让第三方**照文档实现即失败**的漂移。

---

## 7. 测试有效性专项（本版新增，P0-4）

这是本次审计与前版结论分歧最大的一处：**测试数量（716）掩盖了测试质量的空洞。**

### 7.1 源码文本伪测试

`api/_lib/workflows-store.test.ts` 有 **41 处 `readFileSync`** ✅，全仓 **0 处 `vi.mock`** ✅，无 DB 测试装置、无 `vitest.config.*`（无 jsdom、无覆盖率阈值；`@vitest/coverage-v8` 已装但 `package.json` 无 coverage script，本地 `coverage/` 停在 7-31）。

最危险的两条路径是靠**断言源代码字符串**「覆盖」的：

| 断言 | 位置 |
|---|---|
| `functionSource(readFileSync(STORE_SOURCE,'utf8'), 'reconcileWorkflowStages')` | `workflows-store.test.ts:780` |
| 同法取 `projectPullRequestWebhook` | `:813` |
| `source.slice(indexOf('async function reconcileWorkflowScope'), …)` | `:1580` |
| `source.slice(indexOf('export async function projectPullRequestWebhook'), …)` | `:2292` |
| `expect(handler).toMatch(/reconcileWorkflowStages\([\s\S]*?deadlineMs: …/)` | `api/cron/reconcile.test.ts:78` |

更极端的：`:690` 用正则从源码里抠 `postgres(url, {...})` 的选项文本断言 `max > 1`；`:830` 断言 handler 源码里 `, reads)` **恰好出现 5 次**；`:855` 断言 `src/main.ts` 文本不含 `stageSnapshot`。

这类断言**同时失去了测试的两个价值**：行为坏掉时依然全绿，无害重构时必然变红。

### 7.2 破坏性路径零执行覆盖

交叉比对导出与测试引用（本次实测 ✅）：

| 函数 | 被任何 `*.test.ts` 引用次数 |
|---|---|
| `deleteAccount` | 0 |
| `requestDeploymentRollback`（生产回滚） | 0 |
| `createTeam` / `authorizeWorkflowOperation`（团队 RBAC） | 0 |
| `cleanupRetainedData`（数据保留） | 0 |
| `executeWorkflowAutomationAction`（自动化执行） | 0 |

即：**账号删除、生产回滚、团队权限、数据保留这四条用户可感知的破坏性路径从未被执行过。**

### 7.3 覆盖良好的部分（应如实记录）

纯函数层是真行为测试：`src/lib/domain`(15)、`workflow`、`workflow-run`、`team-permissions`、`projected-stage`、`pr-drafts`、`navigation`、`generation-rules`；后端 `api/_lib/github-app`(47)、`http`(18)、`a2a/rpc`(14)、`cron/reconcile`(11)、`github-api`、`installations`、`rate-limit`、`ai-credentials`；加密模块 13 例。

e2e 30 例在真实 Chromium 里驱动整套 UI（授权回跳、审计查询、流程增删改/排序/换仓库、抽屉、PR 创建/合并、失败重跑、自动化策略、部署回滚二次确认、进度条前缀统计、主题色守卫、PR 引用复制），但**全部 `page.route` 桩化后端** ✅（`e2e/pr-helper.spec.ts:31-41`），不触真实 GitHub/Supabase，且**不进 CI**。

安全端点无专项 e2e：CSRF、Webhook 签名、账户删除、隐私页、Push 订阅（保留前版缺口，仍成立）。

---

## 8. 风险汇总与优先级

### P0 — 上线阻断

| 项 | 位置 | 建议 |
|---|---|---|
| **`installation_id` 混淆 → 跨租户读取**（新） | `auth/github/[action].ts:74-87` | 复用 `installationForLogin` 比对 login；服务端一次性 state 绑定 |
| **A2A 端点 fail-open** | `a2a/agent-card.ts:47-53` | 改 fail-closed（缺 token 直接 401）；`ZEUS_A2A_TOKEN` 补入必需清单 |
| **数据库层零租户边界 + RLS 游离于迁移** | 0 条 CREATE POLICY；`supabase-readonly-debugging.md:181-207` | RLS 与 policy 写成迁移 041，先覆盖密文/凭据/审计/用户四张表 |
| **核心状态机只有源码文本伪测试**（新） | `workflows-store.test.ts:780,813,1580,2292` | 建 DB 测试装置后删除文本断言 |
| 文档漂移 D3（隐私政策 vs AI 密钥持久化） | `privacy.html:45` vs `ai-credentials.ts` | 法务/产品确认并修正（前版 P0，保留） |

### P1 — 重要

| 域 | 项 | 位置 |
|---|---|---|
| 后端 | 限流 Map 永不淘汰 + key 含可控 action | `rate-limit.ts:3`、`session.ts:16` |
| 后端 | Webhook 先读流后验签、无尺寸上限 | `webhook.ts:5,9-12` |
| 后端 | Webhook 单一 catch 全压 401 | `webhook.ts:43-44` |
| 后端 | 无事件白名单 | `workflows-store.ts:1339-1343` |
| 后端 | PR 投影不带 installation_id → 租户串写 | `workflows-store.ts:1763` |
| 后端 | 团队路由校验可被对象 `head` 绕过 | `github/[action].ts:39-44` |
| 后端 | 账号删除对团队创建者必然失败 | `workflows-store.ts:2959` × `023:18,34` |
| 后端 | 每次 inbox 11 次同行 UPSERT | `api/[action].ts:52` × `:1006-1010` |
| 后端 | 错误契约靠中文串匹配 + 泄露原始 message | `http.ts:36-44` |
| 后端 | A2A 任务态在实例内存 | `a2a/agent-card.ts:18` |
| 后端 | 无会话吊销 | `github-app.ts:94-111` |
| 后端 | 限流/缓存跨实例失效、drain 无独立锁 | `rate-limit.ts:3`、`github-api.ts:12-13`、`workflows-store.ts:574`（前版保留） |
| 数据 | 保留覆盖不足（多表无界增长） | `workflows-store.ts:2854`、`022:14` |
| 数据 | 清理谓词缺索引 → 每 30min 5 次全表扫 | `workflows-store.ts:2869-2874` |
| 数据 | drain 查询与部分索引谓词不匹配 | `025:53-55` vs `:447-448` |
| 数据 | FK 未建索引（CASCADE/RESTRICT 列） | `025:37`、`023:18,34` |
| 数据 | payload↔关系表双写长期共存 | `:1664-1665`、`036:11` |
| 前端 | 属性位漏转义 / 链接无 scheme 白名单 | `main.ts` 多处 |
| 前端 | 浏览器 lib 硬编码中文破坏 i18n | `generation-rules.ts:142` 等 |
| 前端 | 预检入口 URL 疑似 404（**待线上验证**） | `main.ts:1243` |
| CI | 无类型检查；部署不被测试门禁；e2e 不进 CI | `ci.yml:19-24` |
| CI | Cloudflare `VITE_AUTH_ORIGIN` 无存在性校验 | `deploy-cloudflare-pages.yml:29-30` |
| 文档 | N2 A2A 对外契约端点写错 | `a2a-vassal.md:9` |

### P2 / P3 — 工程卫生

静默吞错 `.catch(()=>undefined)`；bigint id 归一化不一致；CSRF `Origin` 缺失即放行；`/branches/[^?]+` 过宽；inbox 缺 `no-store`；401/429 压成 500/400；可观测性缺失；SSRF 私网段覆盖不全；Webhook 重放窗口；已 settled 阶段无效 `updated_at` 写；prune N+1；enqueue 非事务；迁移 PK 交换非 CONCURRENTLY；030 硬编码生产 URL；冗余索引；`check-migrations.sh` 未接 CI；`main.ts` 关键逻辑缺单测；死列 `snapshot`；健康探针对降级不敏感；`.env.local` OIDC；死代码 6 处；7 个幽灵依赖；`lint` 命名误导；单 chunk 首屏；`@import` 字体阻塞；`index.html lang` 矛盾；进库的 `.agents/`、`.trae/`、92 kB `handoff.md`。

---

## 9. 无法静态确认（需运行时验证）

1. **预检入口是否真的 404** —— 向线上 `*.vercel.app/api?action=preflight` 发一次 GET。
2. **P0-3 的暴露程度** —— 生产库各表 `relrowsecurity`/`relforcerowsecurity` 真值、`anon`/`authenticated`/`service_role` 对 `public` 的 USAGE/SELECT、`DATABASE_URL` 角色是否 `BYPASSRLS`、走 6543 事务池还是 5432 直连。这决定 P0-3 是「理论风险」还是「已暴露」。
3. **P0-1 的可利用性** —— 取决于该 GitHub App 的 `GITHUB_APP_SLUG` 是否公开可安装。
4. 各表行数与字节、dead tuple 比例、autovacuum 是否跟得上（决定 §3.3 各项量级）。
5. `cron.job` 当前是否存在、间隔是否真为 033 的 `*/30`；Vault 中 `pr_helper_cron_secret` 是否存在（缺失则每轮抛异常）。
6. GitHub Environment（`production-vercel` / `production-cloudflare-pages`）是否配置审批规则；仓库变量 `VITE_AUTH_ORIGIN`、`CLOUDFLARE_PAGES_PROJECT` 是否已设。
7. 对账租约与 `skipped` 语义在真实并发下的表现；`pg_advisory_xact_lock`(`:1649`) 与 `workflowSaveConflicts` 的丢更新行为；连接池 `max:4` 在 serverless 复用下是否耗尽。
8. 线上真实已应用迁移基线（`current-state.md:3` 与 `:313` 均称 040 已执行，需以 `pg` 侧记录为准）。
9. `.vercel/output` 本地构建产物中 `.func` 目录不完整（缺 `api/[action]`、`workflows`、`encrypted-sync`），无法判断是构建中断还是路由未发布。

---

## 10. 建议修复顺序

**第一批（阻断项，改动小、收益确定）**
1. `installation()` 校验归属 —— 复用现成的 `installationForLogin`，约 5 行。
2. A2A 改 fail-closed。
3. 账号删除补团队处理（先转移/解散所有权，或改 `ON DELETE CASCADE`），否则隐私承诺不成立。
4. RLS 与 policy 写成迁移 041，先覆盖 `pr_helper_encrypted_sync`、`pr_helper_ai_automation_credentials`、`workflow_operation_audit_logs`、`pr_helper_users`；明确只读角色与 `BYPASSRLS` 边界。
5. 与法务确认 D3（AI 密钥持久化 vs 隐私政策）。

**第二批（让门禁真的能拦住）**
6. CI 加 `tsc --noEmit`；两个 deploy workflow 改为 `workflow_run` 依赖 CI 成功；CI 跑 e2e；把 `tools/check-migrations.sh` 接入 CI。
7. Cloudflare 部署前校验 `VITE_AUTH_ORIGIN` 存在且为合法 origin。
8. Webhook：先验签后读流 + 尺寸上限 + 事件白名单 + 分离错误码。
9. 限流改外部存储（Supabase/KV）+ IP 维度 + 桶淘汰。

**第三批（以可测试性驱动结构偿还）**
10. 为 `workflows-store.ts` 建 DB 测试装置（testcontainers 或 Supabase branch），先覆盖对账 + Webhook 投影 + 账号删除 + 回滚派发 + 团队 RBAC，再按限界上下文拆分该文件；同步删除 41 处源码文本断言。
11. 数据保留扩面 + 补时间列索引 + FK 索引；收尾 payload 关系化（删双写、删 `stage_index` 写入、清理死列与冗余索引）。
12. 前端：按 screen 拆 `main.ts`（先解耦状态），补属性位 `escape` 一致性与链接 scheme 白名单，浏览器侧 lib 文案进 i18n，清理 7 个幽灵依赖并给 `lint` 正名，加 `vite.config` 做 vendor 分包与字体 preconnect。
13. 文档：修正 N1（测试数）、N2（A2A 端点）、N3（能力清单缺 A2A/团队/保留/pg_cron）、N4（skeleton 措辞）、D4/D5/D6。

---

## 11. 结论

PR Helper 在**架构分层、迁移纪律、主题 token 治理、纯函数测试**上确实达到了较高水准，前版对这些的判断成立。但前版「安全基座扎实」的结论需要修正：**认证链上有一条完整的跨租户读取路径，而承载租户隔离的那批代码恰好是测试覆盖最薄的地方**——这两件事单独存在都可修，叠在一起意味着「看起来测过了」比「没测」更危险。

最值得投入的四件事，按投入产出比排序：

1. **补 `installation()` 的归属校验**（约 5 行，关掉唯一的 P0 攻击链）。
2. **让 CI 具备真实门禁**（`tsc --noEmit` + 部署依赖 CI + 跑 e2e），这是防止后续所有回归的地基。
3. **把 RLS 纳入迁移**，给应用层过滤加一道数据库兜底。
4. **建 DB 测试装置并删除源码文本断言**，让对账/投影/删除/回滚第一次真正被执行。

其余 P1/P2 可排入常规迭代；§9 的九项运行时验证建议在一次有意的上线前检查中集中完成，而不是各自零散确认。
