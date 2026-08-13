# PR Helper 当前状态

> 最后更新：2026-08-12（PR #172 已修复 Serverless TypeScript 编译与 Hobby 函数数量限制，Preview Checks 全部通过）
> 本文是当前架构、功能边界和下一阶段工作的事实来源。`docs/superpowers/specs/` 与 `docs/superpowers/plans/` 保存历史决策和实施过程，不作为当前 backlog。

## 产品形态

PR Helper 是 GitHub-first 的 PR / Release Control Tower。用户以项目 Lane 组织仓库，为每个项目配置真实的 Source → Target 合并路径，并在同一看板中完成 PR 创建、门禁跟踪、合并、部署验证和失败恢复。

当前流程支持：

- 线性链路，例如 `feature/* → dev → main`。
- 独立合并路径，例如 `feature/* → dev` 与 `fix/* → dev`。
- 多路径汇聚门禁：下游步骤可等待多个上游路径全部合并且合并后检查成功。
- Lane 上下拖动、键盘/按钮排序和项目状态筛选。

当前不提供任意 DAG 编辑器、流程模板市场或默认开启的自动化执行。按步骤配置的自动 PR/合并/推进方案已确认；自动创建 PR 的服务端第一版已在本地实现，待部署验收，自动合并和自动推进仍未实现。

## 当前整体评估

- **代码质量：7.5/10**。服务端已集中处理 GitHub 权限、阶段决策、幂等队列和凭据边界，测试覆盖稳定；前端 `src/main.ts` 仍较集中，后续应按页面和服务边界渐进拆分。
- **功能质量：8/10**。流程 CRUD、Lane 看板、动态来源、多路径汇聚、PR 创建/合并、五类门禁、合并后 Actions/部署状态、失败恢复和审计均已具备；后台自动创建 PR 待线上真实验证。
- **产品完善度：7.5/10**。个人使用和小团队发布控制塔已可用；多账号权限、private/organization 边界、Web Push 关闭页面投递和部署回滚仍需外部条件验收。
- **生产准备度：7/10**。主链路已有真实 Production 证据，但自动化 PR、健康检查/失败部署投影、确认式回滚和部分协作能力不能仅凭本地测试视为通过。
- **结论：综合 7.5/10**。产品已超过 MVP，可继续作为受控生产工具使用；下一步优先完成后台自动创建 PR 的 Preview/Production 验收和剩余外部条件验收，不建议立即投入画布、模板市场或自动合并。

## 当前架构

| 层 | 实现 | 职责 |
| --- | --- | --- |
| 浏览器 | Vite + vanilla TypeScript + DOM/CSS | Lane 看板、流程编辑器、PR 操作、AI 生成和本地草稿 |
| 安全 API | Vercel Serverless Functions（`api/`） | GitHub App OAuth/session、installation token、工作流持久化、Webhook、Push、回滚调度 |
| 数据库 | Supabase Postgres（`DATABASE_URL`） | GitHub 用户、流程、阶段状态、事件、Push 订阅、部署状态和运行历史 |
| 事件入口 | GitHub Webhook + 定时 reconciliation | 接收状态变化并校准 PR、Checks、Reviews、Actions 与部署 |
| GitHub 执行 | GitHub App installation token | 创建/合并 PR、读取门禁、重跑 Actions、触发回滚 workflow_dispatch |
| 部署 | GitHub Actions → Vercel / Cloudflare Pages | Preview/Production 发布、健康检查、历史与确认式 Production 回滚 |

Vercel 是 GitHub App 会话与 API 的 canonical origin。Cloudflare Pages 是静态前端镜像，通过 `VITE_AUTH_ORIGIN` 调用 Vercel API。

## 已交付能力

### GitHub 与 PR

- GitHub App 授权、仓库选择与“管理授权仓库”返回原页面。
- public、private 和 organization 仓库访问边界由 GitHub installation 控制。
- 创建 PR、门禁满足后执行 merge commit；squash/rebase 仍跳转 GitHub 原生页面。
- 读取 Checks、Commit Status、Review、分支保护、mergeability 和合并后 Actions。
- PR 五类门禁按 GitHub 实际存在的类型显示，不要求所有类别同时出现。

### 看板与流程

- 多项目 Lane 看板、排序、筛选、当前执行位置和最近动态。
- Lane 步骤抽屉内创建 PR、合并、重试 Actions、查看失败详情和部署记录。
- 动态分支规则（如 `feature/*`、`fix/*`）、独立路径与多路径汇聚。
- 流程配置保存在 Supabase，并保留 `localStorage` 回退和显式本地迁移提示。
- 每次保存流程自动生成版本快照；PR 合并时记录运行实例，Overview 看板显示最近运行历史。
- 团队协作：团队 Owner 可创建团队、维护成员角色并共享个人流程；共享成员在 Lane、待办、阶段状态、部署、运行历史和时间线中看到同一份流程投影。已部署，待多账号 Production 验收。
- 共享流程写操作由服务端角色强制执行：Viewer 只读，Operator 可创建 PR/重跑 Actions，Editor 可编辑流程，只有 Owner 可以删除流程、合并 PR 或发起部署回滚。

### AI 与本地草稿

- OpenAI Chat Completions 兼容 SSE 流式生成 PR 标题和描述。
- 已有内容时覆盖前确认；生成和手写内容按仓库/Source/Target 保存 24 小时。
- Markdown 生成规则支持新增、编辑、导入、默认规则和单选。
- AI API Key 当前保存在浏览器 `sessionStorage`：同一标签页刷新和站内跳转后仍然存在，但后端、Webhook 和定时任务无法读取，关闭标签页或换设备后也不能作为无人值守凭据。PR 草稿和生成规则以浏览器本地数据为主，解锁加密云同步原型后可上传/下载密文，尚未承诺自动冲突合并。

### 监控、通知与失败恢复

- GitHub Webhook 签名校验、delivery 去重和数据库投影。
- 定时 reconciliation 补偿漏掉或乱序的事件。
- 服务端待办队列覆盖 Actions 失败、待审批、可合并和可创建下一 PR。
- Web Push + Service Worker 支持页面关闭后的通知；浏览器权限与 VAPID 配置仍是前提。
- 失败 Actions 可重跑，并可生成包含 PR、失败 Job、错误摘要与文件 diff 的 Codex 修复包。
- 失败处理中心：Overview 看板顶部集中展示 Actions 失败、审批不足和部署失败，每项提供一键重试、Codex 修复和查看详情。
- 同步健康度：每次 reconciliation 记录运行遥测（触发来源、阶段数、耗时、失败原因），Overview 看板显示最后成功同步时间、数据新鲜度和过时阶段警告。
- 发布历史时间线：聚合事件（PR 检测、合并、Checks 结果、部署状态、回滚、Actions 重跑）和运行实例，每个项目 Lane 和步骤抽屉显示最近时间线。
- 流程预检：Overview 看板提供一键预检，聚合检查 App 权限、分支存在性、PR 冲突、上游依赖、Actions 和 Environment 配置，每项给出修复建议。
- 失败恢复策略：Actions 重试次数限制（默认 3 次）、冷却时间（默认 5 分钟）和人工升级提示，每个项目可在编辑器中自定义策略，失败中心展示重试进度、冷却倒计时和升级警告。
- 加密云同步（原型）：生成规则和 PR 草稿支持 AES-GCM 256 位加密后上传/下载云端，口令派生密钥（PBKDF2-SHA256, 600k 次迭代），服务器仅存储密文。密钥轮换、冲突处理和线上回归仍待完成。
- Actions 服务端重试：失败 Actions 的重试由服务端校验流程、当前提交、失败运行、最大次数和冷却时间后执行，前端不再直接调用 rerun API。
- GitHub 代理白名单：浏览器代理仅允许当前产品所需的仓库、PR、Checks、Actions、分支和部署读取/操作路径及对应 HTTP 方法。
- 稳定阶段决策：服务端统一输出 `locked`、`waiting`、`checks-failed`、`needs-approval`、`ready-to-merge`、`ready-to-create` 和 `merged` 决策，待办队列与阶段状态共用同一套判断。
- 保存并发保护：流程版本使用数据库事务锁和版本号校验，检测到其他窗口更新时拒绝覆盖。
- 请求安全保护：受保护 API 校验浏览器来源并按登录用户/操作限流；创建 PR 前检查同一 Source → Target 的开放 PR，Actions 重试和部署回滚使用稳定事件键去重。
- 自动化方案：已确认“阈值触发 → AI/PR → 门禁 → 按步骤合并 → 合并后门禁/部署 → 下一步”的产品方案，第一阶段不使用画布，详情见 [`docs/automated-workflow-plan.md`](automated-workflow-plan.md)。`024`–`026` 已执行，服务端加密 AI 凭据、偏好、步骤规则快照、幂等动作队列和后台自动创建 PR 已在本地实现；Webhook、Cron 和 inbox reconciliation 在 `ready-to-create` 时可触发，部署后待真实验收。每个步骤可在流程详情页设置 1–20 的新提交触发阈值，只有 `aheadBy >= 阈值` 才会尝试自动创建 PR；流程编辑页不显示该配置。自动创建 PR 必须同时满足服务端自动流程凭据可用、AI 自动生成标题/描述、自动确认创建和有效规则快照，任一缺失时开关不可启用。条件满足只解除开启资格，不会自动勾选，必须用户主动点击。AI 生成失败时自动动作进入 `paused`，保留脱敏原因；用户可重新生成或手填标题/描述，确认后再 Unpause 继续原动作，不采用未经确认的兜底文案。自动合并、Production 自动合并和自动回滚仍未实现。
- 自动化进度展示方案：流程详情页将增加按步骤的进度条，明确显示已完成、当前、上一步、下一步及暂停原因；状态必须来自服务端统一阶段决策和动作队列。多路径汇聚只有所有前置路径完成后才解锁，人工合并不会显示为自动合并中。该进度条与 AI 接管、Unpause 一并列入后续代码实现和验收。
- AI 失败节点交互已确定：进度条放在每个步骤的“自动创建 PR”控制区下方；AI 生成失败节点点击后打开接管弹窗，用户可重新生成或手填标题/描述，点击“确认并继续自动流程”后恢复原动作。内容确认不会立即把步骤标绿；必须等 PR 创建和全部 GitHub 门禁/合并后部署条件完成，节点才变绿并激活下一步。详细 Tooltip、弹窗字段、服务端校验和幂等恢复规则见 [`docs/automated-workflow-plan.md`](automated-workflow-plan.md)。

### 公网部署

- 按项目和目标分支选择 Vercel / Cloudflare Pages GitHub Actions 工作流。
- 合并后跟踪 Preview/Production Actions，全部成功后才解锁下游步骤。
- 可选 HTTPS 健康检查、失败 Job 摘要、重新部署、最近 8 次运行历史。
- 编辑器与 Lane 显示 Actions 权限、工作流名称、GitHub Environment、健康路径和运行超时问题。
- `bayernjf/pr-helper` 的标准 Production 部署已绑定 `Rollback frontend deployment`；回滚必须由用户确认并再次经过 GitHub Environment 规则。

### 2026-08-12 Production E2E 补充结论

- 在 `bayernjf/pr-helper-e2e-sandbox` 完成 `feature/* → dev` 与 `dev → main` 实际链路：PR #5、#7 合并后触发 Preview；PR #8 从 `dev` 合并到 `main` 后触发 Production。
- PR #8 合并前已验证 `4/4 Checks`、`4/4 Actions` 通过；合并后已验证 `3/3 Checks`、`3/3 Actions` 通过，以及 Vercel 和 Cloudflare Pages Production 部署成功。

### 2026-08-12 刷新链路优化

- 详情页、步骤抽屉及创建/合并/重试/回滚/删除后的刷新按当前仓库触发；流程总览手动刷新和定时任务仍为全量。
- 手动 reconciliation 改为后台执行，接口先返回已持久化快照，避免单个 GitHub 慢请求阻塞页面。
- 浏览器 GitHub API 请求统一设置 20 秒超时；超时后刷新控件恢复可操作。
- 私有仓库 `bayernjf/pr-helper-e2e-sandbox-private` 的 PR #1 已验证 `1/1` 门禁通过；后台同步最近实测约 26 秒，具体慢请求仍待日志定位。
- 已修复并 Production 复验：Actions 未全绿时不显示应用内“合并 PR”；发布运行在合并后终态出现时会从“进行中”更新为“发布完成”。
- 已修复并 Production 复验：动态来源 `feature/* → dev` 在 PR #9 已合并后可由完整 reconciliation 发现并投影至 Lane 与步骤抽屉。
- GitHub App 已订阅 Pull request、Pull request review、Check run、Check suite、Status 与 Workflow run 事件。沙箱 PR #11 重开事件在 GitHub Recent Deliveries 返回 `202`（2.73 秒）；生产详情页未手动刷新，在下一个轮询周期自动展示 `feature/webhook-live-e2e-2 · PR #11`，Webhook 自动投影验收通过。
- “重新同步”在真实全量 reconciliation 下约需 150 秒；当前以 180 秒超时保障结果正确，后台同步和局部更新体验仍是后续优化项。

## 数据边界

| 数据 | 存储位置 |
| --- | --- |
| GitHub 登录、installation id | 签名 HTTP-only session + Supabase 用户记录 |
| GitHub App private key、OAuth secret、installation token | 仅服务端；installation token 短期生成，不进浏览器和数据库 |
| 流程配置、阶段状态、事件、部署历史 | Supabase Postgres |
| 校准运行遥测 | Supabase Postgres（`reconciliation_runs`） |
| 流程版本快照与运行记录 | Supabase Postgres（`workflow_versions`、`workflow_runs`） |
| Push subscription | Supabase Postgres |
| 团队、成员与共享流程关系 | Supabase Postgres（`pr_helper_teams`、`pr_helper_team_members`、`pr_helper_team_workflows`） |
| AI API Key | 浏览器 `sessionStorage` |
| PR 草稿、Markdown 生成规则 | 浏览器 `localStorage`；可通过加密云同步上传服务端（原型） |
| 加密云同步密文 | Supabase Postgres（`pr_helper_encrypted_sync`） |

数据库迁移线上基线为 `001`–`026`，其中 `024_ai_automation_credentials.sql`、`025_workflow_automation_queue.sql` 与 `026_ai_automation_preferences.sql` 已执行。`024` 对应的服务端 API 还要求 Vercel 配置 `AI_CREDENTIALS_ENCRYPTION_KEY`（32 字节 hex 或 base64），不得写入代码、数据库或日志。迁移必须按编号在 Supabase SQL Editor 或独立 migration job 中执行；运行时 API 不创建或修改表。Vercel 已配置 `CSRF_ALLOWED_ORIGINS=https://pr-helper.pages.dev`。

## 最新验证结论

2026-08-03 已在 Vercel Production 与公开 GitHub E2E 沙箱完成一轮可追溯验证，完整结果见 [验证报告](verification-report.md)。真实通过的链路包括 GitHub App 授权、PR 创建、严格分支保护、应用内合并、合并后 Actions 跟踪和多路径汇聚。失败 Actions 的 GitHub 原生阻塞状态也已确认。

本轮发现的连续编辑版本 `409` 已通过 Production 连续新增/删除和整页刷新复验。动态来源规则（如 `fix/*`）已在 Production 通过服务端投影逐条展示实际分支，PR #4 在失败中心、Lane 和抽屉均显示失败；产品内 Actions 重跑、冷却和 Codex 修复包边界也已通过。并发待办刷新导致抽屉短暂读取空快照的问题，已在请求串行修复上线后通过 Production 复验。Webhook 自动投影已在生产完成真实验收。

操作审计的 Production 首次验收曾因动态路由参数冲突而误显示为空；现有 `inbox` 函数已改用不冲突的 `resource=operation-audit` 分流。修复部署后，账户菜单已显示真实的流程更新、创建 PR 和合并 PR 记录，CSV 导出按钮也已启用，验收通过。

## 依赖外部条件的待办

以下项目均已实现对应产品能力，但仍缺少可控的真实外部条件或完整的可追溯证据，不能以本地或手动刷新替代验收。

| 项目 | 当前状态 | 剩余验收 |
| --- | --- | --- |
| Required approval | PR #5 已在第二账号审批后完成应用内合并 | 补齐审批前 `needs-approval` 与审批后 `ready-to-merge` 的完整证据即可关闭 |
| Vercel / Cloudflare 部署 | PR #7 Preview、PR #8 Production 双平台跟踪已通过 | 健康检查、失败投影与确认式 Production 回滚 |
| GitHub Webhook 自动投影 | 沙箱 PR #11 重开事件返回 `202`，且生产详情页无需手动刷新自动显示动态来源 | 通过 |
| private / organization 安装边界 | 未验收 | 需要对应仓库、安装范围和授权内外读写测试 |

下表保留各验收的原始准备条件和完成标准；Required approval 与双平台部署的当前结论以上表为准，尚未关闭的部分仅为补充证据、健康检查、失败投影或回滚。

| 待办 | 你需要准备 | 我负责执行与记录 | 完成标准 |
| --- | --- | --- | --- |
| Required approval | 第二个可访问 E2E 仓库的 GitHub 账号；目标分支启用至少 1 个 required approval；第二账号具备审批权限 | 创建测试 PR、核查审批前后阶段状态，并记录 GitHub 和产品证据 | PR 在审批前显示 `needs-approval`，有效审批后自动变为 `ready-to-merge` |
| Vercel / Cloudflare 部署与回滚 | 低风险仓库中真实的双平台 GitHub Actions、Environment、部署密钥和健康检查地址；确认可执行的 Production 回滚窗口 | 触发并跟踪 Preview/Production，验证失败投影、健康检查和确认式回滚，留存运行与回滚证据 | Preview/Production 门禁、健康检查、部署失败和一次确认式 Production 回滚均可追溯 |
| private / organization 安装边界 | 一个已授权的 private 仓库和一个 organization 测试仓库；在 GitHub App 中明确配置仓库选择范围 | 验证授权范围内的仓库列表、PR/Actions 读写，以及范围外仓库的拒绝行为 | 仓库列表、PR/Actions 读取和写操作均遵守安装边界，未授权仓库不可访问 |

准备完成后只需告知对应验收项已就绪；测试触发、结果判断、证据整理和 `docs/verification-report.md` 更新由 Codex 完成。加密云同步和保留清理不要求额外账号或仓库，分别在测试草稿/规则和下一次生产 Cron 运行可观察时由 Codex 执行回归。

## 测试覆盖

- 本地单元/服务端测试：`npm test` 运行 24 个文件 / 229 个测试（含 cron 分批、自动化动作身份归一化、创建门禁与执行器终态用例）；`npx tsc --noEmit`、`npm run lint` 和 `git diff --check` 同时通过。
- 浏览器回归：`npm run test:e2e` 使用 Playwright Chromium 与本地 Vite，在 API mock 下覆盖 GitHub App 授权返回、新建流程并整页恢复、步骤排序持久化、失败步骤抽屉、创建/合并 PR、删除流程、确认式部署回滚和操作审计查询。它验证真实 DOM、二次确认和浏览器请求负载，不替代真实 GitHub 写入、门禁和部署验收。
- 已新增流程保存队列回归：连续编辑会串行使用服务端返回的新版本，且不会由旧响应覆盖最新编辑；真实跨窗口乐观锁冲突仍会明确报错。
- Production E2E 通过项目与尚未通过的集成项目均以 [验证报告](verification-report.md) 为准。
- `src/lib/` 核心业务逻辑覆盖率 81%+，包括 domain、workflow、generation-rules、pr-drafts、encrypted-sync、navigation 等。
- 新增测试：加密模块加解密往返/错误处理（13 个）、恢复策略验证（5 个）、ensureStageIds（4 个）。
- `main.ts` 的高频看板路径已有浏览器 E2E；创建/合并真实 PR 与 Webhook 自动投影已完成 Production 验收，部署回滚仍需真实外部条件。`preflight.ts` 依赖 GitHub API，目前仍需集成测试。

## 当前运维边界

- GitHub App 的 `Actions` 权限需要 **Read & write**，用于读取运行状态、重跑失败 Actions 和触发回滚工作流。
- GitHub 分支保护、审批要求和 Environment protection 始终由 GitHub 原生强制执行。
- Production 回滚只接受成功的 `main` 部署及不可变平台部署 URL；Preview 不提供回滚。
- Cloudflare Pages 不承载本项目的 GitHub App session/API；其静态页面依赖 Vercel canonical origin。

## 待执行与待验证清单

> 以下所有项目均为人工操作，无法在本地自动完成。按顺序执行。

### 一、数据库迁移（已完成）

当前配置的 Supabase 环境已按顺序执行以下 5 个迁移文件，并完成结构检查：

| 顺序 | 文件 | 创建表 | 用途 |
|---|---|---|---|
| 1 | `db/migrations/014_reconciliation_runs.sql` | `reconciliation_runs` | 已完成 |
| 2 | `db/migrations/015_workflow_versions_and_runs.sql` | `workflow_versions` + `workflow_runs` | 已完成 |
| 3 | `db/migrations/016_encrypted_cloud_sync.sql` | `pr_helper_encrypted_sync` | 已完成 |
| 4 | `db/migrations/017_reconciliation_scope_and_degraded_state.sql` | `reconciliation_runs` / `github_webhook_deliveries` 字段 | 已完成 |
| 5 | `db/migrations/018_stage_identity_compatibility.sql` | 阶段状态、事件、部署和运行记录字段 | 已完成 |
| 6 | `db/migrations/019_stage_identity_primary_keys.sql` | `stage_id` 正式主键、外键和非空约束 | 已完成 |
| 7 | `db/migrations/020_operation_audit_log.sql` | 操作审计记录 | 已完成 |
| 8 | `db/migrations/021_encrypted_sync_hardening.sql` | 密文版本、设备与历史记录 | 已完成，代码已部署，待线上回归 |
| 9 | `db/migrations/022_data_retention.sql` | 数据保留策略配置 | 已完成，代码已部署，待 Cron 运行观察 |
| 10 | `db/migrations/023_team_permissions.sql` | 团队、成员与流程共享模型 | 已完成，代码已部署，待多账号验收 |
| 11 | `db/migrations/024_ai_automation_credentials.sql` | 服务端加密 AI 凭据 | 已完成，代码待部署验收 |
| 12 | `db/migrations/025_workflow_automation_queue.sql` | 自动化运行快照与幂等动作队列 | 已完成，代码待部署验收 |
| 13 | `db/migrations/026_ai_automation_preferences.sql` | 服务端自动生成/自动确认偏好 | 已完成，代码待部署验收 |

已确认 4 个相关表存在，并确认 `reconciliation_runs.user_id`、`github_webhook_deliveries.installation_id`、外键和 `degraded` 状态约束已生效。018 新增的 5 个稳定身份索引均已存在，5 张相关表的 `stage_id` 空值数量均为 0。

`018`–`026` 已执行并完成用户确认；自动化相关代码仍需部署到 Preview/Production 后进行真实 GitHub 验收。

### 二、代码部署状态

- [x] 当前验收批次已部署至 Vercel Production，并以 Production 浏览器回归为准。
- [ ] Cloudflare Pages 镜像的独立部署状态仍需在双平台部署验收中确认。

### 三、发布流程回归测试

- [x] 在公开 E2E 仓库验证 `feature → dev → main` 的创建 PR → 合并 → PR Actions → 合并后 Actions → 下游解锁；部署门禁不在该沙箱范围，见 [验证报告](verification-report.md)。
- [x] 验证合并后 Actions 状态读取和校准正常（PR #1、#2、#3）。
- [x] 验证 Vercel Preview/Production 部署跟踪正常（PR #7 Preview、PR #8 Production）
- [x] 验证 Cloudflare Pages Preview/Production 部署跟踪正常（PR #7 Preview、PR #8 Production）
- [ ] 验证 Vercel Production 回滚（成功部署 → 确认回滚 → GitHub Environment 保护）
- [ ] 验证 Cloudflare Production 回滚（同上）

### 四、GitHub App 权限回归

- [x] public 仓库：授权、仓库列表、PR 操作、Actions 读取
- [ ] private 仓库：同上
- [ ] organization 仓库：同上，并验证组织级安装边界

### 五、新功能验证

| 功能 | 验证内容 |
|---|---|
| 同步健康度 | Overview 显示最后成功同步时间、数据新鲜度、过时阶段警告 |
| 流程版本快照 | 保存流程后自动生成版本；PR 合并时记录运行实例 |
| 发布历史时间线 | 每个项目 Lane 和步骤抽屉显示最近时间线 |
| 失败处理中心 | Overview 顶部集中展示失败项，一键重试、Codex 修复、查看详情 |
| 流程预检 | Overview 一键预检，聚合检查并给出修复建议 |
| 失败恢复策略 | 编辑器配置重试次数/冷却时间；失败中心展示重试进度、冷却倒计时、升级警告 |
| 加密云同步 | 账户菜单 → 云同步 → 输入口令解锁 → 上传/下载（原型，需验证密钥与冲突边界） |
| 数据删除 | 账户菜单 → 删除账号 → 输入 DELETE 确认 → 级联删除全部数据并清除会话 |
| 隐私政策 | 连接页底部和账户菜单均可打开 Privacy Policy 页面 |
| GitHub 权限说明 | 连接页和账户菜单均可打开权限说明对话框，列出每项权限及用途 |

### 六、后续设计决策（待确定）

- 加密云同步正式启用：需确定密钥管理方案（这里指云同步解锁口令仅存内存，页面刷新后需要重新解锁；不是 AI Key）
- 失败恢复策略进一步增强：是否需要服务端持久化策略配置（当前按流程保存在 workflow 中）
- 自动化执行默认值已确认：高风险自动创建、自动合并和自动推进默认关闭，用户逐步骤开启；自动创建 PR 的策略快照、动作幂等和失败暂停已在本地实现，自动合并和自动推进仍未实现。
- 合并后门禁为红时是否继续自动创建下游 PR：**已确认为不创建**。自动创建是无人值守动作，红灯应由人先看，避免把问题带进下一段。详见 [`docs/auto-create-pr-remediation.md`](auto-create-pr-remediation.md)。

### 七、合规

详见 [合规审计报告](compliance-audit.md)。

- ✅ Privacy Policy — `public/privacy.html`，连接页和账户菜单均有入口
- ✅ 数据删除 — `DELETE /api/account` + 账户菜单「删除账号」按钮
- ✅ GitHub App 权限说明 — 应用内权限说明对话框
- 🟢 Terms of Service — 个人项目可暂缓

## 下一阶段优先级

> 详细待执行/待验证清单见上方「待执行与待验证清单」章节，包含数据库迁移、代码部署、发布回归、权限回归和新功能验证的具体步骤。

1. private / organization 安装边界、Web Push、团队多账号协作、加密同步线上回归与数据保留 Cron：详见上方「依赖外部条件的待办」。
2. 完整发布回归：已通过 `feature → dev → main`、PR Actions、应用内合并与双平台 Preview/Production 部署跟踪；健康检查、失败部署投影和 Production 回滚仍待实测。 ⏳ 部分完成
3. 对 public、private、organization 仓库执行一轮 GitHub App 权限回归。 🟡 public 通过 / ⏳ private、organization 待验证
4. 失败恢复已由服务端校验重试次数、冷却时间、当前提交和失败 Actions；仍不自动修改代码或合并生产。
5. 加密云同步已接通密文上传/下载原型，仍需补齐密钥轮换、冲突处理和线上回归后再扩大使用范围。 🟡 待加固
6. 阶段状态、事件和部署历史已切换到稳定 `stage_id`。 ✅ 019 已执行，并已通过当前 Production 流程回归。
7. PR 流程自动化：服务端加密 AI 凭据、步骤级规则快照、`025` 运行快照/幂等动作队列和 `026` 自动化偏好已落地；Webhook、Cron 和 inbox reconciliation 会在 `ready-to-create` 自动入队，执行器会重校验统一阶段决策、服务端自动生成/确认、规则快照、新提交和开放 PR。自动创建 PR 受服务端凭据、AI 自动生成、自动确认和有效生成规则四项前置条件保护，自动合并仍不做。方案与验收标准见 [`docs/automated-workflow-plan.md`](automated-workflow-plan.md)。🔴 2026-08-13 生产查询确认服务端自动创建实际未生效，原因链、修复方案与回归清单见 [`docs/auto-create-pr-remediation.md`](auto-create-pr-remediation.md)；其中身份归一化、失败留痕和 cron 分批已在工作区完成待提交，统一决策模型与执行器幂等化尚未落代码。

### 八、非验收类后续开发

以下事项不阻塞 018，也不需要在当前阶段追加 SQL，但属于后续应继续推进的工程和产品工作：

- **正式切换稳定阶段身份**：`019` 已将核心主键、外键和查询条件从 `stage_index` 切换到 `stage_id`；待 Preview 回归。
- **并发与幂等保护**：为流程版本保存增加并发控制，并为创建 PR、合并、Actions 重试和回滚补充幂等键、CSRF 防护和限流。
- **完整操作审计**：`020` 已执行；创建/合并 PR、流程保存/删除、Actions 重跑和部署回滚的成功/失败结果记录已实现。Production 已显示真实流程更新、创建/合并 PR 记录，CSV 导出按钮可用。✅
- **浏览器 E2E**：已覆盖授权返回、新建/编辑流程、步骤排序、失败恢复、抽屉创建/合并 PR、删除流程和确认式回滚；Webhook 自动投影已通过真实 GitHub delivery 验收。
- **加密同步加固**：已部署 v2 密文格式、v1 兼容读取、口令轮换、设备标识和乐观版本冲突拒绝；`021` 已执行，待线上回归。
- **数据保留与清理**：已部署 Webhook、密文历史、reconciliation、事件、部署运行和审计日志的 30/90/180/365 天保留策略；现有 Cron 每次受限清理 2,000 条，`022` 已执行，待运行观察。
- **团队协作闭环**：已部署团队管理界面、成员角色更新/移除、流程共享、共享流程投影和服务端角色强制执行；`023` 已执行。实际多账号协作与 GitHub App 安装边界仍需 Production 验收。
- **流程归档 / 静音（未开始，待设计）**：现在只有「保留」和「删除整个流程」两种状态，中间态缺失。沙盒、演示和已下线的流程会长期占据收件箱待办，唯一的消除办法是不可逆删除（级联清空全部状态与历史）。需要一个可逆的「归档 / 静音」态：流程与历史保留可查，但不进动作队列、不参与自动化入队、不发通知。设计时至少要定清楚归档流程是否仍被 cron 校准、是否仍接收 Webhook 投影、以及归档态与团队共享和自动化开关的关系。触发这条需求的具体场景见 [`docs/auto-create-pr-remediation.md`](auto-create-pr-remediation.md) 第三节 P7。

## 变更日志

### 2026-08-03 — 真实 E2E 验证与回归修复待部署

| 项目 | 结论 |
|---|---|
| 公开 GitHub E2E | 已通过 GitHub App 授权、PR 创建、严格门禁、应用内合并、合并后 Actions 与多路径汇聚；完整证据见 `docs/verification-report.md`。 |
| 失败门禁 | PR #4 的 GitHub 原生 `PR gate=FAILURE` 与 `BLOCKED` 已确认；动态规则到产品失败处理中心的投影尚未通过。 |
| 保存并发 | 发现连续编辑会以相同版本并发保存并触发 `409`；本地新增按流程串行保存队列和回归测试，待部署。 |
| 刷新超时 | Production 曾在刷新待办队列时出现 Vercel 300 秒 `504`；本地增加 token 缓存、GitHub API 超时和前端超时提示，待部署。 |

### 2026-08-01 — 审计修复批次

| 交付项 | 内容 |
|---|---|
| 同步隔离 | reconciliation 按用户分组，Webhook 统计按 installation 过滤，增加 `degraded` 状态 |
| 稳定阶段身份 | 浏览器加载、服务端保存和远端返回时补齐 `stageId`，运行快照保存阶段 ID |
| 阶段身份兼容迁移 | 新增 `018`，回填流程、状态、事件、部署和运行记录的 `stage_id`，保留旧索引兼容 |
| 服务端 Actions 重试 | 服务端执行失败 Actions rerun，校验次数、冷却、当前提交和失败运行 |
| GitHub 代理边界 | 增加路径和 HTTP 方法白名单，拒绝未授权仓库 API |
| 019 切换完成 | 新增 `019_stage_identity_primary_keys.sql`，服务端查询和写入切换到稳定 `stage_id`；已执行，待 Preview 回归 |
| 并发与安全 | 流程版本并发校验、请求来源校验、用户级限流、开放 PR 去重和回滚事件去重 |
| 统一状态决策 | 服务端统一阶段决策并返回给待办队列和阶段状态 |
| 文档与测试 | 更新当前事实文档，测试扩展至 18 个文件 / 163 项 |

### 2026-07-31 — P0–P4 质量改进 + 合规批次

基于 `docs/product-quality-assessment.md` 评估报告实施，共涉及 **29 个文件**（18 修改 + 11 新建）。

| 优先级 | 交付项 | 新建文件 | 修改文件 |
|---|---|---|---|
| P0 | 统一状态模型 + 同步健康度 | `014_reconciliation_runs.sql` | `workflows-store.ts`, `reconcile.ts`, `webhook.ts`, `main.ts`, `style.css`, `en.ts`, `zh.ts` |
| P1 | 流程版本 + 运行快照 | `015_workflow_versions_and_runs.sql` | `workflows-store.ts`, `[action].ts`, `main.ts`, `workflow.ts`, `workflow.test.ts`, `style.css`, `en.ts`, `zh.ts` |
| P1 | 发布历史时间线 | — | `main.ts`, `style.css`, `en.ts`, `zh.ts` |
| P1 | 失败处理中心 | — | `workflows-store.ts`, `[action].ts`, `main.ts`, `style.css`, `en.ts`, `zh.ts` |
| P2 | 流程预检 | `api/_lib/preflight.ts` | `[action].ts`, `main.ts`, `style.css`, `en.ts`, `zh.ts` |
| P3 | 失败恢复策略 + 用户自定义 | — | `workflows-store.ts`, `[action].ts`, `main.ts`, `workflow.ts`, `style.css`, `en.ts`, `zh.ts` |
| P4 | 加密云同步原型 | `016_encrypted_cloud_sync.sql`, `api/encrypted-sync.ts`, `src/lib/encrypted-sync.ts` | `workflows-store.ts`, `main.ts`, `en.ts`, `zh.ts` |
| 稳定性 | 用户隔离同步、degraded 状态、服务端 Actions 重试 | `017_reconciliation_scope_and_degraded_state.sql` | `workflows-store.ts`, `[action].ts`, `main.ts` |
| 测试 | 补充测试覆盖 | `src/lib/encrypted-sync.test.ts` | `workflows-store.test.ts` |
| 合规 | 数据删除 + 隐私政策 + 权限说明 | `api/account.ts`, `public/privacy.html` | `workflows-store.ts`, `main.ts`, `style.css`, `en.ts`, `zh.ts`, `compliance-audit.md`, `current-state.md` |
| 文档 | 文档同步更新 | — | `current-state.md`, `product-positioning.md`, `AGENTS.md`, `db/README.md` |

**测试变化：** 132 → 163 个测试（新增 31 个），全部通过

## 文档维护规则

- 当前事实优先更新本文、根目录 `README.md`、`AGENTS.md` 和 `db/README.md`。
- 历史规格和实施计划保留原始假设；若已完成或被替代，在文件顶部写明状态并链接到本文。
- 历史计划中的未勾选项不自动等于当前 backlog。
