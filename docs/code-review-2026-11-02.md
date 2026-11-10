# PR Helper · 深度代码评审报告（2026-11-02）

> 评审日期：2026-11-02。评审对象：分支 `dev`，HEAD `fded7692675bc46c483c6ffa551c1c5145827619`（工作树干净）。
> 评审方式：只读静态评审 + 本地实跑验证门；未修改任何源码，未产生提交。
> 与前序文档的关系：`docs/code-audit-report.md`（2026-10-08，HEAD `1038b415`）之后，代码侧仅新增一个 `.gitignore` 提交（`fded7692`）。本报告对旧审计全部 P0/P1 结论逐条回读源码复核，并补充依赖健康与验证门实测。旧审计仍成立的条目标注「旧审计复核：仍存在」，本报告不重复其完整论证，只给出定位与现状证据。

---

## 1. 仓库定位与规模概览

PR Helper 是 GitHub-first 的 PR / 发布控制塔：浏览器端 Vite + 原生 TypeScript（无框架），API 为 Vercel Serverless Functions（`api/`），持久化为 Supabase Postgres（`DATABASE_URL` 直连，`postgres.js`），监控靠 GitHub Webhook + 定时对账，通知走 Web Push。

实测规模（本次 `wc -l` / `find` 统计）：

| 维度 | 数值 |
|---|---|
| TypeScript 文件（不含 node_modules/dist/.worktrees） | 85 个，18,545 行 |
| 最大单文件 | `src/main.ts` 3,189 行；`api/_lib/workflows-store.ts` 2,993 行；`api/_lib/workflows-store.test.ts` 2,724 行 |
| 数据库迁移 | `supabase/migrations/001–040`，与 README/AGENTS 所述基线一致 ✅ |
| E2E | `e2e/pr-helper.spec.ts` 单文件 30 用例 |
| GitHub Actions | 5 个 workflow（ci、deploy-vercel、deploy-cloudflare-pages、reconcile、rollback） |
| 当前分支 / 工作树 | `dev`，干净（`git status --porcelain` 0 行） |

## 2. 结论摘要

| 严重度 | 数量 | 一句话概览 |
|---|---|---|
| P0 | 2 | 安装绑定 IDOR 跨租户攻击链未修；A2A 端点缺 token 时 fail-open |
| P1 | 8 | 账号删除对团队创建者必然失败；预检功能路由 404；Webhook 投影无租户过滤；路由校验可绕过；隐私政策与实现矛盾；CI 无类型检查且部署不被测试门禁；SSRF 私网段覆盖不全；全库零 RLS |
| P2 | 11 | 验证门失真（lint 实为 build）、29 条依赖漏洞（3 critical）、会话无吊销、限流跨实例失效等 |
| P3 | 6 | i18n 硬编码中文、单 chunk 无分包、文档数字漂移等 |

**最关键 3 条**：

1. **P0-1 安装绑定不校验归属**（`api/auth/github/[action].ts:74-87`）：任意已登录用户可用他人 `installation_id` 换得该安装的完整 App 权限（读私有仓、建/合 PR、重跑 Actions）。修复约 5 行，旧审计 10-08 已给出方案，至今未落地。
2. **P1 账号删除承诺不成立**（`api/_lib/workflows-store.ts:2988-2993` × `supabase/migrations/023_team_permissions.sql:18,34`）：`created_by`/`shared_by` 为 `ON DELETE RESTRICT`，建过团队或共享过流程的用户调 `DELETE /api/account` 必然 FK 冲突失败——这是隐私功能 + 隐私政策双重违约。
3. **P1 CI 质量门失真**（`.github/workflows/ci.yml`、`package.json:8`）：`npm run lint` 实际是 `vite build --emptyOutDir`，仓库无任何 ESLint 配置；CI 全流程不执行 `tsc --noEmit`，`api/` 约 5.2k 行不进 vite 构建——类型与静态检查在 CI 上完全缺席，且 deploy workflow 不依赖 CI 结果。

## 3. 验证门实际执行结果（2026-11-02 本机实测）

| 门 | 命令 | 结果 | 关键输出 |
|---|---|---|---|
| 类型检查 | `npx tsc --noEmit` | ✅ 通过 | 0 错误（strict: true，include: src+api） |
| 单元测试 | `npm test` | ✅ 通过 | 33 文件 / **726 用例全绿**，6.02s |
| 生产构建 | `npm run build` | ✅ 通过 | JS 261.40 kB（gzip 74.86 kB）、CSS 73.75 kB（gzip 13.35 kB），单 chunk |
| E2E | `npm run test:e2e` | ✅ 通过（1 flaky） | 29 passed + 1 flaky（`page.goto` 冷启动 30s 超时，重试后过；总 1.8m，真实 Chromium） |
| Lint | `npm run lint` | ⚠️ 名义通过、实际失真 | 该脚本 = `vite build --emptyOutDir`，与 build 完全同义；仓库**无 ESLint 配置文件**（`ls -a | grep -i eslint` 为空） |
| 依赖审计 | `npm audit` | ❌ | **29 条（19 moderate / 7 high / 3 critical）**，critical 为 `next`、`tinypool`、`vitest` |

说明：CI（`ci.yml`）执行的是 lint→test→build 三步，即 CI 实际只跑了「build × 2 + test」，类型检查与真实 lint 均不在任何自动化门禁里。`tsc` 当前恰好干净，靠的是开发者自觉。

## 4. 逐条发现

### 4.1 P0（可被利用 / 数据损坏 / 上线阻断）

#### P0-1 GitHub App 安装绑定不校验归属 → 跨租户全权（旧审计复核：仍存在）

- **位置**：`api/auth/github/[action].ts:74-87`（`installation()`）；对照同文件 `:58-72`（`install()` 正确使用 `installationForLogin` 比对 `account.login`）。
- **证据**：`installation()` 仅用 App JWT 调 `/app/installations/{id}` 确认安装**存在**（`:81`），随后把该 ID 签进 7 天会话 cookie（`:82`），全程不校验 `installation.account.login === session.login`。`api/_lib/installations.ts:6-8` 现成有正确的比对函数未被复用。
- **攻击链**（各环节均已回读代码确认）：
  1. 攻击者正常登录后访问 `/api/auth/github/installation?installation_id=<受害者安装 ID>`；
  2. 代理 `api/github/[action].ts:99` 用受害者 installation token 执行白名单内任意 GET（`/installation/repositories` 列全部私有仓、pulls、check-runs、environments 等）；
  3. 写操作被 `authorizeWorkflowOperation` 要求「自有/共享流程 + repository 匹配」，但 `upsertWorkflow`（`api/_lib/workflows-store.ts:1663-1726`）**从不校验 `workflow.repository` 是否属于调用者安装**——攻击者自建一个指向受害者仓库的流程即可满足，进而 `POST /repos/{o}/{r}/pulls`、`PUT /pulls/{n}/merge`（GitHub 侧分支保护仍然生效，但 App 权限内的写全部放开）；
  4. `userForLogin`（`workflows-store.ts:1037`）以 `COALESCE` 把该 installation 写进 `pr_helper_users.github_installation_id`，污染持久化状态，服务端自动化（rerun/rollback/drain）随之以受害者身份执行。
- **影响**：对该 App 任一安装（含组织安装）下仓库的私有数据读取与 App 权限内写入。可利用性前提是需要获知受害者 installation_id（数字 ID，出现于安装管理 URL 与 webhook 载荷，非机密但也不可枚举）；该 App 是否公开可安装**未确认**。
- **修复建议**：`installation()` 复用 `installationForLogin` 比对 `session.login`；组织安装场景如需支持，应校验调用者在 GitHub 侧对该组织可见性；并把 `install → installation` 的 ID 传递改为服务端一次性 state 绑定。同时 `upsertWorkflow` 增加「repository 属于当前 installation」校验（调 `/installation/repositories` 或缓存比对）。

#### P0-2 A2A JSON-RPC 端点缺 token 时 fail-open（旧审计复核：仍存在）

- **位置**：`api/a2a/agent-card.ts:47-53`：`const expected = process.env.ZEUS_A2A_TOKEN; if (expected && bearerToken(request.headers) !== expected) { 401 }`——`expected` 未配置时整个 POST 面匿名可用。
- **当前缓解**（已回读确认）：`api/_lib/a2a/skills.ts:36-41` 对 `mode:'execute'` 恒返回 `credentialRequired`（input-required），技能只产出 plan 文本，不触达 GitHub/DB，任务存储为进程内 `Map`（`agent-card.ts:18`）。`docs/a2a-vassal.md` 明确这是设计行为。
- **残余风险**：匿名面可被无成本刷 CPU/内存（每请求同步执行 + 无速率限制）；一旦未来「委派凭据」落地而忘记此处 fail-open，即升级为远程命令面。另外 token 比较用 `!==` 非恒定时间（`agent-card.ts:48`），实践中风险低。
- **修复建议**：生产环境缺失 `ZEUS_A2A_TOKEN` 时启动即拒绝服务（fail-closed）或默认 401；token 比较改 `timingSafeEqual`。

### 4.2 P1（严重缺陷）

#### P1-1 账号删除对团队创建者必然失败（旧审计复核：仍存在）

- **位置**：`api/_lib/workflows-store.ts:2988-2993`（`deleteAccount` 只 `DELETE FROM pr_helper_users`）× `supabase/migrations/023_team_permissions.sql:18,34`（`pr_helper_teams.created_by`、`pr_helper_team_workflows.shared_by` 均为 `REFERENCES pr_helper_users(id) ON DELETE RESTRICT`）。
- **证据**：001 迁移主表是 `ON DELETE CASCADE`（`001_users_and_workflows.sql:24`），但 023 引入的两处 RESTRICT 使任何建过团队或共享过流程的用户删除时触发 FK 冲突，`api/account.ts:17` 返回 400 与原始数据库错误文案。其余 15 张用户关联表均为 CASCADE（本次逐个 grep 确认）。
- **影响**：隐私功能（账号删除）对恰恰是重度用户的群体 100% 失败；与 `public/privacy.html` 的删除承诺直接冲突。
- **修复建议**：删除前在同一事务内显式处理团队（转让/解散）与共享关系，或将两处 FK 改为 CASCADE/SET NULL 并配新迁移；同时 `023` 的两个 RESTRICT 列均无索引（`023:18,34`），删除路径全表扫。

#### P1-2 预检（preflight）功能路由 404，生产静默失效

- **位置**：`src/main.ts:1243` 请求 `/api?action=preflight`；其余全部 API 调用均为 `/api/<段>` 路径形式（本次逐一核对 `githubAppApiUrl(...)` 全部 20 处调用）。
- **证据**：Vercel 文件路由下 `/api` 需要 `api/index.ts`——该文件不存在（`ls api/index.ts` 失败）；`vercel.json` 的 4 条 rewrite（`/api/ai-credentials`、`/api/automation`、两条 agent-card）均不覆盖 `/api`。故该请求在生产为 404，前端走 `preflightError` 兜底（`main.ts:1245-1249`）。线上 404 未实测（只读评审未发请求），属高置信静态推断。
- **修复建议**：改为 `/api/preflight?workflowId=...`（动态段路由，与 `rerun-actions` 等一致）。

#### P1-3 Webhook PR 投影按仓库名匹配、无 installation 过滤 → 跨租户串写（旧审计复核：仍存在）

- **位置**：`api/_lib/workflows-store.ts:1792`（`WHERE workflows.archived = false AND workflows.repository = ${pull.repository}`，JOIN 出了 `users.github_installation_id` 却不用于过滤）；写库 `:1799` 同样无 installation 条件。入口 `api/github/webhook.ts:31-33` 持有 `payload.installation.id` 但未传入。
- **影响**：B 用户登记了指向 A 仓库全名的流程后，A 的每次 PR 事件都会向 B 的阶段状态表投影并可驱动 B 的自动化队列判定。写者仍是 B 自己的行、执行用的是 B 自己的安装（无权仓库会在 GitHub 侧失败），所以是状态污染 + 隔离破口，尚不构成直接写对方仓库；与 P0-1 组合后放大。
- **修复建议**：`projectPullRequestWebhook` 入参加 `installationId` 并在 SQL 层过滤（对账扫描 `:2454` 一带的定时路径已有该过滤，可对齐）。

#### P1-4 团队路由校验可被非字符串 head/base 绕过（旧审计复核：仍存在）

- **位置**：`api/github/[action].ts:39-44`（`pullRequestBranches` 只接受字符串形式的 `head`/`base`，否则返回 `{}`）× `api/_lib/workflows-store.ts:1479`（`if (input.source && input.target && !...)`——任一缺失即跳过路由匹配）。
- **影响**：`POST /repos/{o}/{r}/pulls` 的调用方只要把 `head`/`base` 传成对象或省略（GitHub 对缺省 base 用默认分支），「流程中必须存在对应 Source→Target 路由」这条团队约束即被跳过；repository 匹配与角色校验仍生效，所以影响限于「绕过流程路由约束」，不构成越仓。
- **修复建议**：`pull-created` 场景强制要求字符串 head 且把缺省 base 显式解析为目标默认分支后再校验；非字符串直接 400。

#### P1-5 隐私政策与 AI 密钥实现直接矛盾（旧审计复核：仍存在）

- **位置**：`public/privacy.html:45`（"We do not store your AI API keys on the server; they are kept only in your browser session."）× `api/_lib/ai-credentials.ts:22-28` + `supabase/migrations/024_ai_automation_credentials.sql`（服务端 AES-256-GCM 加密落库，属「服务端自动化」已上线功能）。
- **影响**：合规/法务风险，非技术漏洞。浏览器侧 AI key 确实只在 sessionStorage（`src/main.ts:816`），但服务端自动化凭据是另一份持久化拷贝。
- **修复建议**：修订隐私政策措辞（区分浏览器会话凭据与服务端加密自动化凭据），或下线服务端存储。

#### P1-6 CI 无类型检查、部署不被测试门禁、lint 名不副实（旧审计复核：仍存在）

- **位置**：`.github/workflows/ci.yml`（步骤为 `npm run lint`→`npm test`→`npm run build`，无 `tsc --noEmit`）；`package.json:8`（`lint = vite build --emptyOutDir`）；无 `vite.config.*` 与任何 ESLint 配置；`deploy-vercel.yml`/`deploy-cloudflare-pages.yml` 与 CI 同在 `push: dev/main` 独立触发，无 `needs:`/`workflow_run:` 依赖。
- **实测**：`npx tsc --noEmit` 本地当前 0 错误（纯粹靠自觉）；`api/**` 不进 vite 构建，其类型错误 CI 永远不会发现；单测红的提交可直上 production。
- **修复建议**：CI 增加 `npx tsc --noEmit` 步骤；`lint` 换成真实 ESLint（或干脆删除该脚本并停止假装有 lint）；两个 deploy workflow 改为 `workflow_run` 依赖 CI 成功。

#### P1-7 AI Base URL 的 SSRF 私网段覆盖不全（旧审计复核：仍存在）

- **位置**：`api/_lib/ai-credentials.ts:6-12`。仅挡 `localhost`/`::1`/`127.0.0.1`/`10.*`/`192.168.*`/`172.16.*`/`.local`。
- **缺口**：`169.254.0.0/16`（云元数据）、`100.64.0.0/10`（CGNAT）、`172.17–172.31.*`（私网 172.16/12 只挡了首段）、IPv6 ULA/link-local（`fc00::/7`、`fe80::/10`）、IPv4-mapped IPv6（`[::ffff:127.0.0.1]` 经 URL 归一化后不匹配字符串黑名单）；`src/lib/ai.ts:11-14` 的 `testAiConnection` 未设 `redirect: 'error'`，302 可跳到内网。服务端在保存凭据（`api/workflows.ts:42`）与测试已存凭据（`workflows-store.ts:66-71`）时都会向该 URL 发真实请求。
- **缓解因素**：强制 https；发出的 body 只有 `ping`，Authorization 头是用户自己提供的 key；Vercel 环境无 EC2 式元数据面。定为 P1 偏保守，按利用条件可降 P2。
- **修复建议**：改用 IP 解析后按 CIDR 段判定（含 IPv6），禁 redirect，必要时加出站域名白名单。

#### P1-8 全库零 RLS，租户隔离完全依赖应用层（旧审计复核：仍存在；生产姿态未确认）

- **证据**：`grep -rn 'ROW LEVEL SECURITY' supabase/migrations/`（001–040 共 40 个文件）**零命中**；隔离全部依靠各查询里的 `WHERE user_id = ...`（如 `visibleWorkflowPredicate`，`workflows-store.ts:1446-1455`）。
- **评估**：浏览器从不直连 Supabase，唯一 DB 客户端是 API（`DATABASE_URL`），因此这不是暴露面而是**纵深防御缺口**——任何一处应用层漏判（如 P1-3）都没有数据库层兜底。生产库 `relrowsecurity`、`DATABASE_URL` 角色是否 `BYPASSRLS`、连接走 6543 池还是 5432 直连：**未确认**（只读评审无法连生产库）。
- **修复建议**：至少确认 `DATABASE_URL` 角色非 superuser/BYPASSRLS；中长期对 26 张表启用 RLS 并以 `user_id` 策略兜底。

### 4.3 P2（质量 / 可维护性 / 性能）

1. **依赖健康差**：`npm audit` 29 条（3 critical：`next`、`tinypool`、`vitest`；7 high：`brace-expansion`、`js-yaml`、`nanoid`、`postcss`、`sharp`、`source-map-js`、`vite`）。其中 `next`、`react`、`react-dom`、`tailwindcss`、`postcss`、`autoprefixer`、`eslint` 为**零引用幽灵依赖**（`AGENTS.md:13` 明确「不使用 React 或 Next.js」，全仓无对应 import 与配置文件），critical 的 `next`  advisories 纯属死重量；运行时依赖 `postgres`、`web-push` 本身无 advisory。建议卸载 7 个幽灵包并 `npm audit fix`。
2. **会话无吊销**（`api/auth/github/[action].ts:89-92`）：logout 只清客户端 cookie，被窃签名 cookie 在 7 天内全权有效，唯一手段是轮换全局 `AUTH_SESSION_SECRET`。建议会话表化或短 TTL + refresh。
3. **限流跨实例失效**（`api/_lib/rate-limit.ts:1-16`）：进程内 `Map`，Vercel 多实例/冷启动即重置；key 含 query 可控的 `action` 名（`api/_lib/session.ts:16-17`），可通过变换 action 名无限放大 bucket 数。当前仅为防滥用兜底，建议至少注明「非安全边界」，或换 Upstash 等共享存储。
4. **CSRF Origin 缺失即放行**（`api/_lib/http.ts:23-25`）：无 `Origin` 头的变更请求直接通过（浏览器 form POST 在 `SameSite=Lax` 下被挡，故实际风险低；属纵深缺口）。
5. **代理路径正则过宽**（`api/github/[action].ts:52` 等）：`/branches/[^?]+` 允许斜杠与 `..` 点段，`fetch` 会做 URL 归一化，理论上可跳出 `/repos/{o}/{r}/branches/` 前缀落到其他 GET 端点；installation token 的权限范围使实际收益有限（越仓即 404），仍建议显式拒绝 `..` 与多段路径。`/user/repos`→`/installation/repositories` 的重写（`:98`）无此问题。
6. **每次 inbox 对同一用户行约 11 次 UPSERT**（旧审计复核：仍存在）：`/api/inbox` 扇出的 11 个 list 函数各自 `await userForLogin(...)`（`workflows-store.ts:1036-1038`，INSERT ... ON CONFLICT DO UPDATE），一次看板轮询 = 11 次写。建议请求级缓存 user 行或把 UPSERT 降为 SELECT + 惰性建户。
7. **关键 SQL 路径仅有源码文本断言**（旧审计复核：仍存在）：`api/_lib/workflows-store.test.ts:779-827` 用 `readFileSync` 读 `workflows-store.ts` 源码做 `toContain` 断言来锁定 sweep/projection 的 SQL 形态（该文件 397 个用例中约 41 处此模式，其余为真行为测试）。这是 egress 优化的刻意回归锁，但对账与 webhook 投影两条核心链路**没有执行级测试**，行为回归只能靠生产观测。
8. **`src/main.ts` 3,189 行单模块**：69 处顶层 `let` 全局状态、38 处 `innerHTML` 整树重建（本次逐一核查，用户/远程数据插值均过 `escape()`，未发现可直接利用的 XSS；`escape` 定义于 `main.ts:141`）；182 处 `addEventListener` 靠布尔位防重。是测试难做与 e2e 只能桩化后端的结构性原因。
9. **构建零分包**：无 `vite.config.*`，单 chunk JS 261.40 kB / gzip 74.86 kB 全量首屏，无 vendor 分离/preload（实测，见 §3）。`src/style.css:1` 以 `@import` 串行拉第三方字体且无 preconnect；`index.html:2` 硬编码 `lang="zh-CN"` 而默认 locale 为 en（`src/main.ts:3186`）。
10. **i18n 破口**（旧审计复核：仍存在）：`src/lib/github.ts:18,52,57`、`src/lib/team-permissions.ts:21-35`、`src/lib/ai-stream.ts`、`src/lib/encrypted-sync.ts` 等浏览器模块硬编码中文错误文案直达 UI，EN 用户会看到中文。服务端中文错误信息同时承担状态判别职责（`api/_lib/http.ts:36-44` 按中文子串映射状态码），脆弱但功能内聚。
11. **会话内安装 token 缓存无界**：`api/_lib/github-api.ts:12` 的 `installationTokenCache` 为进程内 Map 且无淘汰（token 1h 过期后条目仍在，靠下次写入覆盖）；多安装场景下缓慢增长，serverless 长暖实例可见。量级小，列此备查。

### 4.4 P3（体验 / 规范）

1. **文档数字漂移**：`docs/current-state.md:17` 写「691 个单元测试」，`docs/code-audit-report.md:8` 写「716」，本次实测 **726**（33 文件）。`handoff.md` 已 95 kB 且持续追加，检索成本上升。
2. **A2A token 比较非恒定时间**（`api/a2a/agent-card.ts:48`），且任务存储为进程内 `Map`（`:18`），多实例下 `tasks/get` 命中漂移。
3. **Push 订阅 endpoint 仅校验 `https://` 前缀**（`api/_lib/push.ts:20-25`）：用户可登记任意 URL 让服务端在事件触发时 POST（带 VAPID JWT，aud 为该源）——自用型 blind POST，风险低，建议限定已知 push 服务商域名。
4. **Webhook 错误统一压成 401**（`api/github/webhook.ts:43-44`）：配置缺失（500 性质）与验签失败混同，排障信号差；且先读完整 body 再验签（HMAC 所需，可接受）。
5. **`requestErrorStatus` 默认 500/400 混杂**：`api/github/[action].ts:117` 非 GitHubApiError 一律 401（含 DB 故障），`api/[action].ts:118` preflight 一律 500；状态码语义失真干扰监控。
6. **e2e 冷启动 flake**：本次实测 1 例 `page.goto` 30s 超时（dev server 冷启动），重试即过；`playwright.config.ts:19` `reuseExistingServer: !CI` 本地无碍，但 e2e 不进 CI（`ci.yml` 无 Playwright 步骤），30 个浏览器用例只保护本地。

### 4.5 值得保持的实践（本次抽样核实）

- 迁移纪律：001–040 有序增量、无运行时 DDL、旧迁移不回改；`workflowSaveConflicts` 乐观锁 + `pg_advisory_xact_lock`（`workflows-store.ts:1678-1686`）。
- 自动化队列原子领取：`UPDATE ... SET state='running' WHERE state='queued' RETURNING`（`workflows-store.ts:603`），drain 与 reconcile 并发下不会双跑。
- Webhook 验签用 `timingSafeEqual`（`github-webhook.ts:7-12`）；cron 端点统一 `CRON_SECRET` bearer（`api/cron/*.ts`）。
- AI 凭据 AES-256-GCM + 随机 IV + 版本化密文（`ai-credentials.ts`）；浏览器同步 PBKDF2 600k + AES-GCM（`src/lib/encrypted-sync.ts:17`）。
- 会话 cookie `HttpOnly; Secure; SameSite=Lax`（`http.ts:57-59`）；OAuth state 签名 + 10 分钟过期（`github-app.ts:75-92`）。
- 前端插值转义一致（38 处 `innerHTML` 全部过 `escape()` 或静态文案）；PR 复制链接由 `githubPullUrl()` 硬编码 `https://github.com/` 前缀生成。
- `.vercelignore` 排除 `*.test.ts`，避免测试文件被发布为 Serverless 路由。
- `docs/code-audit-report.md`（10-08）质量极高：本次复核其 P0×4、P1 主干结论**全部仍成立且定位精确**，未发现过时结论。

## 5. 文档与实现一致性

| 文档声明 | 实现现状 | 结论 |
|---|---|---|
| README:50「迁移基线 001–040」 | 40 个迁移文件 | ✅ 一致 |
| AGENTS.md:41 同 | 同 | ✅ 一致 |
| README:34 / AGENTS.md:25 把 `npm run lint` 列为检查项 | lint 实为 `vite build --emptyOutDir`，无 ESLint 配置 | ❌ 名不副实 |
| `current-state.md`「691 个单元测试」 | 实测 726 | ⚠️ 过时（向好的漂移） |
| `handoff.md` 常用命令含 `npm run lint` | 同上 | ⚠️ 同样失真 |
| `privacy.html:45`「不在服务端存 AI key」 | 服务端加密存储（024 迁移） | ❌ 矛盾（P1-5） |
| `docs/code-audit-report.md` 列出的 P0×4 | 全部仍存在 | ⚠️ 已知未修 |
| AGENTS.md:9「AI keys 浏览器侧 session-only」 | 浏览器侧属实（`main.ts:816` sessionStorage） | ✅ 一致（服务端凭据是另一份） |

## 6. 修复优先级建议

**第一梯队（本周内，投入极小收益极大）**

1. P0-1：`installation()` 复用 `installationForLogin` 校验归属（约 5 行）+ `upsertWorkflow` 增加 repository 归属校验。
2. P1-2：preflight 改为 `/api/preflight`（1 行）。
3. P1-6：CI 加 `npx tsc --noEmit`；deploy workflow 挂 `workflow_run` 依赖。
4. P1-1：`deleteAccount` 事务化处理团队与共享关系（或新迁移改 FK 行为 + 补索引）。

**第二梯队（下个迭代）**

5. P1-3：webhook 投影 SQL 加 `installation_id` 过滤（入参已有）。
6. P1-4：`pull-created` 强制字符串 head/base 校验。
7. P1-5：修订 `privacy.html` 措辞。
8. P2-1：卸载 7 个幽灵依赖 + `npm audit fix`（直接消掉全部 3 条 critical 中的 `next`）。
9. P1-7 / P0-2：SSRF CIDR 判定 + A2A fail-closed，两个都是「未来功能落地前必须完成」的硬门槛。

**第三梯队（结构性，排期投入）**

10. P1-8：生产库 RLS 姿态核查 → 逐表启用。
11. P2-7：为 reconcile sweep / webhook 投影补执行级测试（testcontainers 或 pg-mem），把源码文本断言降级为辅助。
12. P2-8：`main.ts` 按页面/服务边界渐进拆分（AGENTS.md 已立项）。

---

*本报告为只读评审产物，未改动工作区任何文件；所有「仍存在」结论均在 HEAD `fded7692` 上回读源码确认，无法静态确认的运行时事实（生产 RLS 姿态、App 可安装性、/api 404 实测）已逐条标注「未确认」。*
