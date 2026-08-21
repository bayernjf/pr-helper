# PR Helper 当前状态

> 最后更新：2026-08-21（服务端自动创建 PR 与逐步骤自动合并均已在生产端到端跑通；自动化队列 drain 是唯一执行入口；流程详情页的只读进度条已上线；Supabase Free Plan 出现 Egress 超额，已实测定位到「详情页轮询隐藏不停」与「同一请求内重复读 payload」两项，均已修，见《Supabase Egress 与多用户扩展方案》）
> 本文是当前架构、功能边界和下一阶段工作的事实来源。`docs/superpowers/specs/` 与 `docs/superpowers/plans/` 保存历史决策和实施过程，不作为当前 backlog。

## 产品形态

PR Helper 是 GitHub-first 的 PR / Release Control Tower。用户以项目 Lane 组织仓库，为每个项目配置真实的 Source → Target 合并路径，并在同一看板中完成 PR 创建、门禁跟踪、合并、部署验证和失败恢复。

当前流程支持：

- 线性链路，例如 `feature/* → dev → main`。
- 独立合并路径，例如 `feature/* → dev` 与 `fix/* → dev`。
- 多路径汇聚门禁：下游步骤可等待多个上游路径全部合并且合并后检查成功。
- Lane 上下拖动、键盘/按钮排序和项目状态筛选。

当前不提供任意 DAG 编辑器、流程模板市场或默认开启的自动化执行。按步骤配置的自动 PR/合并/推进方案已确认；服务端自动创建 PR 与逐步骤自动合并均已在生产端到端跑通（见《2026-08-15 生产实测结论》）；合并后自动推进仍未实现。

## 当前整体评估

- **代码质量：7.5/10**。服务端已集中处理 GitHub 权限、阶段决策、幂等队列和凭据边界，测试覆盖稳定（553 个单元测试）；前端 `src/main.ts` 仍较集中，后续应按页面和服务边界渐进拆分。
- **功能质量：8.5/10**。流程 CRUD、Lane 看板、动态来源、多路径汇聚、PR 创建/合并、五类门禁、合并后 Actions/部署状态、失败恢复和审计均已具备；后台自动创建 PR 和逐步骤自动合并已有生产成功记录。
- **产品完善度：7.5/10**。个人使用和小团队发布控制塔已可用；多账号权限、private/organization 边界、Web Push 关闭页面投递和部署回滚仍需外部条件验收。
- **生产准备度：7/10**。主链路和两级自动化都已有真实 Production 证据；健康检查/失败部署投影、确认式回滚和部分协作能力不能仅凭本地测试视为通过。Supabase Free Plan 在上个账单周期出现 Egress 超额（`pr-helper` 6.28GB / 5GB），当前高频 `/api/inbox` 把看板状态与历史数据绑在一起，不适合直接承载多用户轮询。
- **结论：综合 7.5/10**。产品已超过 MVP，可继续作为受控生产工具使用；下一步优先降低 Supabase Egress（轮询时钟已整个删掉、请求内去重与 payload 内容哈希化均已完成，最终判定要等一周 Supabase Usage，最早 2026-08-28），再继续收敛 reconciliation 写入和完成外部条件验收，不建议立即投入画布或模板市场。

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
- 自动化方案：已确认“阈值触发 → AI/PR → 门禁 → 按步骤合并 → 合并后门禁/部署 → 下一步”的产品方案，第一阶段不使用画布，详情见 [`docs/automated-workflow-plan.md`](automated-workflow-plan.md)。`024`–`031` 已执行，服务端加密 AI 凭据、偏好、步骤规则快照、幂等动作队列和后台自动创建 PR 均已部署并在生产跑通；Webhook、`pg_cron` 和 inbox reconciliation 在 `ready-to-create` 时可触发。每个步骤可在流程详情页设置 1–20 的新提交触发阈值，只有 `aheadBy >= 阈值` 才会尝试自动创建 PR；流程编辑页不显示该配置。自动创建 PR 必须同时满足服务端自动流程凭据可用、AI 自动生成标题/描述、自动确认创建和有效规则快照，任一缺失时开关不可启用。条件满足只解除开启资格，不会自动勾选，必须用户主动点击。AI 生成失败时自动动作进入 `paused`，保留脱敏原因；用户可重新生成或手填标题/描述，确认后再 Unpause 继续原动作，不采用未经确认的兜底文案。自动合并的第 5 阶段已于 2026-08-14 落地并于 2026-08-15 在生产验证通过（见《2026-08-15 生产实测结论》）：按步骤勾选框位于流程详情页「新提交数达到」右侧，策略与自动创建**状态独立**（互不清除，可只开自动合并），但**界面可勾选条件与自动创建对齐**（同样要求四项 AI 前置，另加 `pull-merge` 权限）；该对齐只在界面，服务端入队不校验 AI 前置。只做 merge commit 且必带 `sha = pull.head.sha`、`mergeable_state='behind'` 只暂停不自动 update branch、失败次数达 `recoveryPolicy.maxRetries` 后停在 `paused` 不再自动重排、PR 已 merged 记幂等成功。Production 自动回滚仍不做。勾选自动创建或自动合并从关变开时，保存路径会打上 `reconcile_pending_since` 并立即触发一次校准，先有提交/先有 PR、后勾选的情形不再等下一次 push；若该次勾选会立即产生动作（有待创建的提交或有开着的 PR），界面先弹确认并写明源、目标与 PR 编号，取消则不保存——这个确认就是 `AGENTS.md` 第 5 条要求的明示用户动作。门禁不在界面预判，仍由服务端 `automationMergeOutcome` 权威判定。勾选后的反选是尽力而为而非取消保证：执行器认领动作后会重读工作流 payload，反选若已落库则动作抛「策略已失效」，但窗口只有 push 到 webhook 投递的 1–3 秒。
- 自动化进度展示方案：流程详情页的只读整体进度条已于 2026-08-19 上线（状态来自服务端统一阶段决策和动作队列，标注对账时间，详情页轮询会刷新投影）；方案要求的步骤级放置、上一步/下一步解锁条件呈现以及 AI 接管、Unpause 等写入路径仍列入后续代码实现和验收。多路径汇聚只有所有前置路径完成后才解锁，人工合并不会显示为自动合并中。
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
- 2026-08-14 本地已落地（待部署验收）：webhook 与收件箱刷新改为在预算内 `await` 校准后再返回，按事件分支收窄范围，抑制同仓并发 sweep，中断的校准会被定时校准收尾并在界面提示，定时校准按 `last_reconcile_attempt_at` 公平轮转（需先执行迁移 `027`）。
- 2026-08-14 第二批本地已落地（待部署验收，需先执行迁移 `028`）：并发抑制从会话级 `pg_try_advisory_lock` 换成 `reconciliation_leases` 自过期租约（TTL 30 秒、TTL/3 心跳续租），因为被冻结的实例永远不会执行自己的 unlock，生产上曾把同仓 sweep 挡住 8.7 分钟；超预算让出时按当前计数写终态并落 `finished_at`，`trigger='webhook'` 不再停在 `running`；推迟或失败的工作流打上 `reconcile_pending_since`，由下一次实时触发优先接力（最多 4 个），因为 GitHub Actions 的 `*/10` 计划在生产实际间隔 50–100 分钟。
- 服务端模块不得引入任何顶层读 `import.meta.env` 的浏览器模块：该越界曾使 `/api/github/session` 在模块加载阶段崩溃并返回 `FUNCTION_INVOCATION_FAILED`，现由源码守卫测试沿相对导入链检查。
- GitHub App 已订阅 Push、Pull request、Pull request review、Check run、Check suite、Status 与 Workflow run 事件。沙箱 PR #11 重开事件在 GitHub Recent Deliveries 返回 `202`（2.73 秒）；生产详情页未手动刷新，在下一个轮询周期自动展示 `feature/webhook-live-e2e-2 · PR #11`，Webhook 自动投影验收通过。
- “重新同步”在真实全量 reconciliation 下约需 150 秒；当前以 180 秒超时保障结果正确，后台同步和局部更新体验仍是后续优化项。

### 2026-08-15 生产实测结论

生产库直接查询（时间为 UTC）：

- **自动创建 PR：47 个动作 `succeeded`**，1 个 `paused`（`The operation was aborted due to timeout`）。
- **逐步骤自动合并：37 个动作 `succeeded`**，10 个 `paused`、2 个 `queued`。10 个 `paused` 中 7 个原因是 `门禁尚未全绿`，属设计正确的行为；异常只有 3 个，全是 GitHub 侧超时或 `CONNECT_TIMEOUT`。至此第 5 阶段在生产端到端跑通。
- 近 12 小时 sweep 分布：`cron` 120 次全部 success，`webhook` 100 success / 443 skipped / 39 degraded / 5 failure，另有 2 次停在 `running`。

新增的调用成本遥测第一次量化了 reconciliation 的 GitHub 开销，近 12 小时：

| 触发 | sweep 次数 | GitHub 调用 | 平均 GitHub 耗时 |
| --- | --- | --- | --- |
| `cron` | 120 | 8,275 | 16.3 秒 |
| `webhook` | 131 | 1,095 | 1.8 秒 |
| `manual` | 10 | 54 | 1.3 秒 |

**约 88% 的调用配额由定时校准消耗**，而不是 Webhook。这解释了 2026-08-14 installation 配额被打爆、自动合并被迫暂停的现象，也说明「一次投递扫多轮」提升覆盖率的同时抬高了配额压力。当日晚间按小时复核后该结论被下调，见《2026-08-15 调用预算复核与 drain 实测》。

### 2026-08-15 本批修复

- **失败保存不再丢配置**：保存队列在请求进行中合并的编辑，遇到该请求失败时会被静默丢弃，导致用户勾选的自动合并从未到达服务端；现在失败会清理待存标记并回报具体流程 id，由界面重新读取服务端状态对齐，勾选框不再显示服务端没有接受过的开关。
- **实时校准不再拖垮保存**：保存响应会等待一次实时校准，而原先的预算只覆盖阶段工作，租约等待和周边查询在预算之外，生产上曾把保存从 5 秒拖到 400 秒以上并丢写；现在整轮 sweep 受同一预算约束，超时即记 `deferred` 交给下一次触发。
- **重试预算不再被供方拒绝消耗**：`attempts` 每次认领即自增，配额耗尽或请求超时这类从未得到 GitHub 裁决的拒绝会白白花掉 3 次额度并永久退役自动合并；现在这类原因在暂停时退回一次尝试，只有 GitHub 真正给出裁决（冲突、落后、策略失效）才计入。
- **无版本历史的老流程恢复可保存**：版本机制上线前建的记录 `payload.version` 为空且 `workflow_versions` 无任何行，而并发校验要求客户端回显一个它从未拿到的版本号，导致这些记录永久无法保存、刷新也无法自愈。`workflowSaveConflicts` 现在把「无版本历史」视为可认领。生产已确认修复生效：33 个流程 version-less 记录归零。
- **排序不再回退版本**：排序取自拖动前的看板快照，期间落地的保存响应会被整体覆盖回旧版本号，下一个请求即被判为冲突。`applyWorkflowOrder` 改为只把位置贴到当前内存记录上，并把整盘并发保存改为串行。生产已确认修复生效：33 个流程的 position 唯一且连续（0–32）。
- **自动化队列自愈**：新增计划端点在每次校准 sweep 之后 drain 卡住的动作，恢复不再依赖新的 push 事件；drain 中执行抛错的动作会被 park，避免后续 sweep 反复重试同一个。
- **部署门禁可维护**：门禁可就地编辑而非删除重建、可从仓库实际的 Actions 工作流重新派生和同步、新建流程时按所选仓库预填候选；没有任何 Actions 工作流的仓库不再被塞入默认门禁，清空配置的步骤会退役对应数据行。
- 其余：详情页刷新一律触发服务端校准；未设预算的 sweep 等待自身阶段结束再报完成；等待中的门禁保持 `queued` 而不是 `paused`；`duration_ms` 不再把回收前的等待计入耗时。

### 2026-08-19 深色主题失配与自动化僵尸行修复

三类问题都在生产界面上出现过，成因各不相同，共同点是浅色模式下完全正常，因此既没有报错也没有构建失败。

- **发明出来的 token 名**：进度条、自动化徽标与明细、失败中心、预检面板、同步健康条、运行历史、抽屉时间线、恢复策略设置等较新的样式块用了 16 个从未定义过的变量名（如 `--border`、`--muted-text`、`--card-bg`），并给每处 `var()` 写了十六进制兜底，共 114 处。CSS 于是静默采用兜底色，深色主题的 token 覆盖对它们完全无效。已全部映射到项目真实 token 并删掉所有兜底；其中 4 处承载语义色的边框（`.sync-health-banner.success`、`.fp-node.is-succeeded`、`.lane-run-history li.completed`、`.pf-pass`）保留为 `--text-success`。
- **`<dialog>` 不继承页面文字色**：浏览器 UA 样式表把 `dialog` 的 `color` 钉在 `CanvasText`，它跟随系统配色而与我们自己的 `data-theme` 属性无关，因此深色下 7 个弹窗的标题是黑字（实测 `rgb(0,0,0)`，而同一时刻 `--text-primary` 已是 `#e8ecf0`）。`.step-drawer` 显式写了 `color` 所以一直正常。已加一条基础规则 `dialog { color: var(--text-primary) }`。
- **背景 token 当文字色用**：`.primary` 是 `background: var(--bg-accent-light); color: var(--bg-accent)`，这个配对只在浅色下成立（深绿字 + 极浅绿底）；深色主题独立重绘了两侧，变成深绿字 + 中绿底，实测对比度 1.6:1。同类写法共 5 处（另有 `.toast-undo` 是反向的同一错误）。已新增 `--text-on-accent`（浅色 `#153d31`、深色 `#f5f7fa`），`.primary` 深色对比度升到 5.9:1，浅色保持 10:1 不变；`.toast-undo` 改用 `--text-white`，与同一深色 toast 上的 `.toast-close` 统一。

守卫测试 `src/style-theme-tokens.test.ts` 现有 5 条断言，覆盖上述三类：所有 `var()` 名字必须能在 `:root` 解析、不得出现字面色兜底、浅色 token 必须在深色全部被覆盖、`dialog` 必须有主题文字色、不得用 `--bg-*` 作为 `color`。这类问题此前无法被任何测试或构建发现，只能靠肉眼在深色下逐屏看。

**paused 动作不再冒充步骤的最新状态**：生产上 `bayernjf/pr-helper` 第 2 步（dev→main）的 PR 已在 11:36 合并，界面却持续显示「自动创建 PR · 已暂停，需要处理」。成因有两层：`latestAutomationAction` 按 `updated_at` 跨 kind 取最新，而那条因门禁未满足而 paused 的 create-pr 每次重试都会被推新时间戳（11:50），于是永远比真正完成该路径的 merge-pr（11:36）更「新」；同时排空判定的取代子查询带了 `newer.kind = actions.kind`，merge-pr 取代不了 create-pr，而「门禁未满足」属于已给出裁决的 verdict，连过期清理也会 `skip`，这一行因此永久留存。已在排空判定中新增 `hasNewerSucceeded`：同一 workflow + stage + source 上存在更晚创建且已 `succeeded` 的动作（不限 kind）时把 paused 行 cancel 成 superseded；原有同 kind 判定与 queued / running 分支行为不变。**这一条属于已部署未验证**——那条具体的行在 12:22 被 12:21 排入的新 create-pr 按原有同 kind 规则取代掉了（与预测的自愈一致），新规则至今没有独立触发的机会。

### 2026-08-15 调用预算复核与 drain 实测

drain 首轮在生产运行（Actions run `31880783398`，6 次 sweep）：

- 第一次 sweep `{"examined":7,"reclaimed":1,"cancelled":6,"failed":1}`。6 条判为「已被后续提交取代」取消，1 条（`id 84`）从 `running` 回收成 `queued` 并退还误扣的尝试；未结束动作从 7 条降到 1 条。恢复不再依赖新的 push，这一点已由生产数据证实。
- 随后 5 次 sweep 全部 `{"examined":1,"failed":1}`：`id 84` 每 75 秒被执行一次、每次都抛错，而行仍停在 `queued attempts=0`。原因是执行器在原子领取之前抛错时不写任何裁决，而 drain 当时只记日志不动行——一个不收敛的自旋。已修：抛错时 drain 把原因写回该行并置 `paused`，UPDATE 以 `state IN ('queued','running')` 为条件，绝不覆盖执行器越过领取后写下的裁决；失败明细同时随 drain 响应返回，下一次 sweep 自己就能说出原因，不必依赖 Vercel 日志。

**park 后读出的原因是 `排空时执行失败：无效的自动化执行请求`，据此定位到 drain 自身的一行缺陷。** `workflow_automation_actions.id` 是 `bigint`，postgres.js 把它作为字符串返回；执行器入口第一行用 `Number.isInteger` 把关，字符串直接被判为无效请求，在原子领取之前抛错。仓库里 `automationActionId` 的注释本就写明了这件事，其余 8 个调用点都经过它，只有 drain 把 `row.id` 原样传了进去。含义是**上线以来 drain 一次都没有真正执行过动作**——首轮 `executed: 0` 不是「没有可执行的动作」，而是每一条都在入口被拒。已修：drain 先用 `automationActionId(row.id)` 归一化，取不到整数则记 `drain-invalid-action` 跳过，绝不把无效身份送进执行器。`DrainActionRow.id` 的类型也从 `number` 改为 `string`，不再对运行时说谎。

因此 `id 84` 被写下的那句原因是这个缺陷的产物，不是它真实的裁决；它当前停在 `paused attempts=0`，而 drain 按设计不碰 `paused`，需要一次人工重排才能让修复真正被走到。

调用预算按小时复核（近 24 小时，UTC）：

| 指标 | 值 |
| --- | --- |
| 24 小时总调用 | 约 9,976（`cron` 8,733 / `webhook` 1,189 / `manual` 54） |
| 峰值小时 | 1,204 次（08-15 10:00） |
| GitHub App 装在个人账号的基线 | 5,000 次/小时 |
| 峰值占用 | 约 24% |

**结论：调用预算从第一优先级降级为阈值观察。** 调用量随「流程数 × 覆盖轮数」线性增长，29 个流程的峰值只占 24%，流程翻倍到 60 个约 48%，离天花板仍有距离；`github_calls` 已在逐轮记录，等峰值小时越过约 2,500 次（一半）再设计预算模型，比现在凭空定预算可靠。08-14 的配额耗尽发生在分批与租约修复之前，不能作为当前扫描强度的证据。

同时确认 `duration_ms` 的口径修复已生效：修复前该字段把回收前的等待一并计入，`webhook` 行最大值曾达 4,166 秒（69 分钟），根本不可能是单次调用；部署后近 70 分钟内 `webhook` 最大 10.4 秒、`cron` 最大 33.6 秒 / p90 22.3 秒，字段已可用于判断真实耗时。由此得到一个比调用预算更值得做的事：`REALTIME_RECONCILE_BUDGET_MS = 8000` 是为躲 10 秒平台上限定的，而 `maxDuration` 已提到 60 秒、`cron` 实测 p90 22.3 秒，这个常数现在偏保守，应按实测重定。

## 数据边界

| 数据 | 存储位置 |
| --- | --- |
| GitHub 登录、installation id | 签名 HTTP-only session + Supabase 用户记录 |
| GitHub App private key、OAuth secret、installation token | 仅服务端；installation token 短期生成，不进浏览器和数据库 |
| 流程配置、阶段状态、事件、部署历史 | Supabase Postgres |
| 校准运行遥测 | Supabase Postgres（`reconciliation_runs`） |
| 校准并发租约 | Supabase Postgres（`reconciliation_leases`，自过期，超时行由保留清理回收） |
| 流程版本快照与运行记录 | Supabase Postgres（`workflow_versions`、`workflow_runs`） |
| Push subscription | Supabase Postgres |
| 团队、成员与共享流程关系 | Supabase Postgres（`pr_helper_teams`、`pr_helper_team_members`、`pr_helper_team_workflows`） |
| AI API Key | 浏览器 `sessionStorage` |
| PR 草稿、Markdown 生成规则 | 浏览器 `localStorage`；可通过加密云同步上传服务端（原型） |
| 加密云同步密文 | Supabase Postgres（`pr_helper_encrypted_sync`） |

数据库迁移线上基线为 `001`–`031`，`027`–`031` 覆盖 `skipped` 动作状态、校准调用成本遥测、`pg_cron` 时钟和被回收扫描的名额归还。`024` 对应的服务端 API 还要求 Vercel 配置 `AI_CREDENTIALS_ENCRYPTION_KEY`（32 字节 hex 或 base64），不得写入代码、数据库或日志。迁移必须按编号在 Supabase SQL Editor 或独立 migration job 中执行；运行时 API 不创建或修改表。Vercel 已配置 `CSRF_ALLOWED_ORIGINS=https://pr-helper.pages.dev`。

## 最新验证结论

2026-08-03 已在 Vercel Production 与公开 GitHub E2E 沙箱完成一轮可追溯验证，完整结果见 [验证报告](verification-report.md)。真实通过的链路包括 GitHub App 授权、PR 创建、严格分支保护、应用内合并、合并后 Actions 跟踪和多路径汇聚。失败 Actions 的 GitHub 原生阻塞状态也已确认。

本轮发现的连续编辑版本 `409` 已通过 Production 连续新增/删除和整页刷新复验。动态来源规则（如 `fix/*`）已在 Production 通过服务端投影逐条展示实际分支，PR #4 在失败中心、Lane 和抽屉均显示失败；产品内 Actions 重跑、冷却和 Codex 修复包边界也已通过。并发待办刷新导致抽屉短暂读取空快照的问题，已在请求串行修复上线后通过 Production 复验。Webhook 自动投影已在生产完成真实验收。

操作审计的 Production 首次验收曾因动态路由参数冲突而误显示为空；现有 `inbox` 函数已改用不冲突的 `resource=operation-audit` 分流。修复部署后，账户菜单已显示真实的流程更新、创建 PR 和合并 PR 记录，CSV 导出按钮也已启用，验收通过。

## 当前最高优先级：Supabase Egress 与多用户读取扩展

2026-08-21 的 Supabase Usage 显示 Free Plan Egress 为 6.309GB / 5GB（126%），其中 `pr-helper` 项目占 6.28GB，宽限期到 2026-09-20；若仍超额，Supabase 请求可能返回 402。

当前根因判断是高频 `/api/inbox` 同时返回看板当前状态与历史详情数据。浏览器轮询和页面长时间打开会重复拉取 events、timeline、workflow runs、deployment runs、audit logs 和 automation history。用户数增加时，Supabase Egress 会随在线用户近似线性增长。

2026-08-21 已按各查询的实际列和 LIMIT 在生产库上量过字节，权重与上述判断不同：一次 `/api/inbox` 约 588 kB，其中 `pr_helper_workflows.payload`（35 行、70.8 kB）在**同一次请求内被 5 个 list 函数各取一遍**，占 354 kB，重复的 4 遍即 283 kB / 48%；历史数据合计只有 143 kB / 24%。按 30 秒轮询折算约 70 MB/小时，5 GB 约等于 71 小时页面打开时间——每天前台使用 4 小时、一个月即到量，现有超额无需多用户即可解释。可见性方面只有详情页有问题：首页 `refreshOverviewSnapshot` 开头本来就有 `document.visibilityState !== 'visible'` 即返回，详情页的 `pollTimer` 没有（本文档首版写成「首页轮询也不停、挂机一晚约 847 MB」是错的，已按源码更正）。

因此第一阶段的落地顺序已修正为先做前两项，`/api/board` 拆分降为可选：

- **详情页轮询隐藏即停、两屏间隔改 60 秒**：已完成（`1e5c6758`）。**间隔后来不复存在**：第二轮 A3（`538a33eb`）把轮询时钟整个删掉，两屏只在回到前台和用户动作时刷新，因此「60 秒」是过期表述。2026-08-22 生产实测确认详情页隐藏期零请求；同日修掉「切回标签页触发两次相同请求」（`f40bf119`）并复测通过。进一步的「回到前台最小间隔」已决定暂不做，等一周 Supabase Usage 出结论（最早 2026-08-28）。
- **请求内去重**：已完成（`2b81be2c`），handler 传一个按请求的 memo 进各 list 函数，payload 与 stage_states 各只读一次。
- **去掉无人读取的 `stage_snapshot`**：已完成（`98b5d245`），`INSERT` 保留，列和历史数据仍在。
- 三刀实测合计：单次 594.3 → 274.0 kB（−53.9%），前台 71.3 → 16.4 MB/小时，详情页挂后台归零，5 GB 可支撑前台时长从约 70 小时升到约 312 小时。之后观察一周，再决定是否需要下列改动。
- （可选）新增轻量 `/api/board`，首页只读取 Lane 渲染所需的当前状态、门禁摘要、待办数量、未完成自动化摘要和同步时间。
- （可选）timeline、events、deployment runs、workflow runs、audit logs 改为进入流程详情、步骤抽屉或历史 Tab 时按需加载。
- 首页自动化动作只返回未完成摘要，不读取 200 条历史动作。
- 手动“刷新 GitHub 状态”仍触发校准；Webhook、cron 和自动化队列负责后台推进。

后续阶段包括 board version / ETag 增量响应、服务端看板投影表、历史数据分页和保留策略、多用户下的 reconciliation lock、限流和 GitHub API 预算。完整方案见 [Supabase Egress 与多用户扩展方案](supabase-egress-optimization.md)。

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

- 本地单元/服务端测试：`npm test` 运行 29 个文件 / 536 个测试；`npx tsc --noEmit` 和 `npm run build` 同时通过。
- 浏览器回归：`npm run test:e2e` 使用 Playwright Chromium 与本地 Vite，在 API mock 下覆盖 26 个用例，包括 GitHub App 授权返回、新建流程并整页恢复、步骤排序持久化、失败步骤抽屉、创建/合并 PR、删除流程、确认式部署回滚、操作审计查询、编辑既有流程时步骤表单折叠、换仓库确认，以及流程详情进度条的步骤状态、前缀计数、同步时间标注与全部完成后不再高亮当前步。它验证真实 DOM、二次确认和浏览器请求负载，不替代真实 GitHub 写入、门禁和部署验收。
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

`018`–`031` 已执行并完成用户确认；自动创建 PR 与逐步骤自动合并均已部署且在生产验收通过，「幂等命中记成功」已于 2026-08-15 在沙箱验完，自动化验收清单无未验项。

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
- 自动化执行默认值已确认：高风险自动创建、自动合并和自动推进默认关闭，用户逐步骤开启；自动创建 PR 的策略快照、动作幂等和失败暂停已实现并在生产跑通。自动合并已在本地落地待验收，其策略与自动创建**状态独立**（互不清除），但界面可勾选条件与自动创建对齐；服务端入队不校验 AI 前置条件。合并后自动推进仍未实现。
- 被回收的扫描会白吃掉一个轮转名额：**已修**（迁移 `031` + `f7cd0252`）。扫描按设计在干活之前盖 `last_reconcile_attempt_at`（解析不出路由的流程也要让位），实例中途被回收时这一章仍然生效而活没干；而让这类流程插队用的 `reconcile_pending_since` 只在扫描跑到末尾时才写，于是这个标记唯一为之存在的场景恰好是它漏掉的场景。现改为把认领的流程 id 记在 run 行上，回收僵尸 run 时在同一条语句里把它们标回 pending。2026-08-15 实测：18:31:59 推送 → 18:32:02 的 webhook 扫描认领 1 个步骤后被回收（18:40:02 回收，`stages_reconciled=0`），`bayernjf/pr-helper` 因此排到队尾，推送 13 分钟后投影仍停在 `ahead_by=0`；每轮 8 个流程、共约 30 个，一次完整轮转约 20 分钟。
- 等门禁的动作会被无限重试：**已修**（`6a0ede17`）。`automationMergeOutcome` 把「审批不足」标成 `retryable`，执行器于是把动作留在 `queued` 而不是 `paused`——而封顶重排的 `automationRetryIsExhausted` 只看走到过判决的行，`queued` 不在其列，于是这条路径根本没有上限。迁移 `030` 把排空收到每 2 分钟后放大了 20 倍：2026-08-15 动作 205（`PR 还需要 1 个 Approval`）在 65 分钟里累计 41 次尝试，每次都花 GitHub 调用，而门禁只有人能清。清门禁的事件本身会触发校准并就地执行该动作（`scheduleServerAutoMerge` 命中已 `queued` 的行直接执行），所以定时重试只是「事件漏了」的兜底，不是时效来源。现按 `recoveryPolicy.cooldownSeconds`（默认 300 秒，可配 0–86400）退避、随尝试次数翻倍、封顶 30 分钟；`cooldownSeconds` 显式配 0 表示不等。41 次尝试的场景由此降到每小时 2 次。2026-08-15 19:30 部署后实测：排空由 `executed 1 / skipped 1` 变为 `executed 0 / skipped 2`，`attempts` 停在 46；同日 19:31:58 给 PR #12 approve → 19:32:01 收到 `pull_request_review/submitted` → 19:32:20 合并、19:32:21 动作 `succeeded`，事件到合并 19 秒，退避不影响时效。
- 合并后门禁为红时是否继续自动创建下游 PR：**已确认为不创建**。自动创建是无人值守动作，红灯应由人先看，避免把问题带进下一段。详见 [`docs/auto-create-pr-remediation.md`](auto-create-pr-remediation.md)。

### 七、合规

详见 [合规审计报告](compliance-audit.md)。

- ✅ Privacy Policy — `public/privacy.html`，连接页和账户菜单均有入口
- ✅ 数据删除 — `DELETE /api/account` + 账户菜单「删除账号」按钮
- ✅ GitHub App 权限说明 — 应用内权限说明对话框
- 🟢 Terms of Service — 个人项目可暂缓

## 下一阶段优先级

> 详细待执行/待验证清单见上方「待执行与待验证清单」章节，包含数据库迁移、代码部署、发布回归、权限回归和新功能验证的具体步骤。
>
> 用户 2026-08-15 决定：自动化进度条 UI 后置（见第 5 项），当前主线只有一条——自动创建 PR / 自动合并 PR 的稳定性。

0. **`id 84` 重排已关闭，bigint 修复已由其他动作在生产验证（本项收尾，无待办）**。2026-08-15 13:03 用户按建议把 `id 84` 重排回 `queued`，但它 `created_at` 为 01:03:20，恰在 13:03 跨过 `AUTOMATION_ACTION_STALE_MS`（12 小时），而 `automationDrainDecision` 的 stale 判定排在 execute 之前，因此它只会被下一次 sweep 标记 `cancelled / 超过自动化时限，未再尝试`，拿不到真实裁决。提出该建议时未核对动作年龄，属规划疏漏。修复本身已被真实执行验证：12:36–13:11 之间 `id 113`–`121` 共 8 条动作 `succeeded`（`attempts` 1–3，领取与重排均正常），`id 111` 被正确判为 `superseded` 而 `cancelled`——这是排空器上线以来第一次真正执行动作。

1. **瞬时失败的重排路径已实现，待生产验证（当前第一优先级）**。`drainWorkflowAutomationActions` 现在也读 `paused` 行，`automationDrainDecision` 对 `paused` 只在「失败原因存在且 `automationAttemptWasReached` 判为未触达供方」时返回 `requeue`，并叠加多重界限：未被更新动作取代、仍在 12 小时 stale 窗口内、距上次更新超过 `AUTOMATION_TRANSIENT_REQUEUE_COOLDOWN_MS`（15 分钟）、`attempts` 未达 `AUTOMATION_TRANSIENT_REQUEUE_MAX_ATTEMPTS`（3）。冷却是必需的：领取前抛出的故障不计 `attempts`，仅靠次数上限无法收敛。重排写入以读到的 `state = 'paused'` 为条件，期间若有真实裁决写入则裁决胜出。批次排序改为 `ORDER BY (actions.state = 'paused'), actions.created_at`，避免最老的 `paused` 行占满 10 条批次、饿死本该执行的队列行。7 条「门禁尚未全绿」是 GitHub 已给出的裁决，仍留在 `paused` 不动。**更正**：此前记录「`automationAttemptWasReached` 的正则漏掉 `CONNECT_TIMEOUT`」是错的——`timed? ?out` 在忽略大小写下已经匹配 `TIMEOUT`，无需改正则，现由测试固定该分类。超窗的瞬时失败改判 `cancel / stale` 而不是继续 `skip`：没有别的机制会重试它，留在 `paused` 就是把一个已死的意图长期钉在失败中心里；GitHub 已给出的裁决无论多老都保持 `paused`，那是操作者唯一的记录。因此 `id 6` / `58` / `80` 会被清成 `cancelled`，不会被救回；重排路径本身的生产验证要等下一次真实的瞬时故障。`id 84` 已于 2026-08-15 13:29 按预期清成 `cancelled / 超过自动化时限，未再尝试`。

2. **实时校准预算已按触发方分开，生产已验证（无待办，仅留结论）**。原先一个 8 秒常数同时服务三种触发方，而它们的约束正相反：webhook 的响应体没有任何调用方读，投递本身要求把这次事件涉及的 1–2 个步骤跑完；保存与收件箱刷新背后有人在等，让出不等于丢工作（`reconcile_pending_since` 会让下一次触发接力）。因此 `webhook` 提到 `WEBHOOK_RECONCILE_BUDGET_MS = 25000`，`manual` / `inbox_refresh` 保持 8000，`REALTIME_RECONCILE_BUDGET_MS` 环境变量仍可一并覆盖。同时把外层兜底从 `budgetMs * 2` 改为 `realtimeReconcileCeilingMs(budgetMs)`（`min(budgetMs + 15s, 60s - 15s)`）：外层只是给永不落地的 I/O 兜底，不是第二份预算，16 秒时它离预算太近，会在 sweep 还活着时把它甩掉，25 秒预算再翻倍则直接越过平台上限。依据见《2026-08-15 实时校准预算的实测重定》。**2026-08-15 14:49 部署后核对**：webhook 12 次成功、让出 0、被回收 0（部署前 24 小时 292 / 149 / 60）；p50 9.0 秒、最长 17.2 秒，全部在旧的 8 秒预算之上。cron 11 次全成功，p50 14.1 秒，校准 130 个步骤。待补齐标记为 0。`manual` / `inbox_refresh` 暂无部署后样本，仍需在日常使用中观察 p90。

3. **时钟已搬进数据库，生产已验证（无待办，仅留结论）**。近 7 天相邻 cron 送达的间隔：p50 46 分、p90 82 分、最大 152 分，而一次送达只覆盖约 7.5 分钟（`SWEEPS: 6` × 75 秒），约 85% 的时间没有 drain 在跑；被回收实例留下的已领取行本该 `AUTOMATION_ACTION_ABANDON_MS`（120 秒）后就能接手，实际最坏等 2.5 小时。迁移 030 用 `pg_cron` + `pg_net` 打这两个端点：**drain `*/2`**（对齐 abandon 窗口，队列空时不产生 GitHub 调用）、**reconcile `*/5`**（每次扫掠约 69 次调用，5 分钟一次 = 828 次/小时；2 分钟则单这一项 2070 次/小时，直接压第 6 项那条 2500 次/小时的线，故不取）。密钥不进仓库：迁移只建 `public.pr_helper_cron_ping(endpoint)`（`security definer`），调用时从 Vault 取 `pr_helper_cron_secret`，取不到就抛错——否则只会在 `net._http_response` 里留一片 401，看着像端点坏了。`timeout_milliseconds` 给 90 秒，因为 pg_net 默认 5 秒会把正常干完活的调用记成超时。Actions 作业保留为兜底但 `SWEEPS` 6 → 1（重叠无害：抢不到 `reconciliation_leases` 的触发记 `skipped`）。**不采用「把 Actions 循环拉长」**：仓库是 public、分钟数免费，但 p90 82 分、最大 152 分超出任何单次作业的合理循环时长，且计划工作流在仓库连续 60 天无提交后会被 GitHub 自动停用，覆盖率仍挂在会漂移的调度器上。**你要做的一次性操作**：在 Supabase SQL Editor 执行 `select vault.create_secret('<CRON_SECRET 的值>', 'pr_helper_cron_secret');`，然后应用迁移 030。**2026-08-15 17:06 UTC 上线后核对**：`net._http_response` 前 5 条全是 200,时间落在 17:06 / 17:08 / 17:10×2 / 17:12——drain 每 2 分钟、reconcile 每 5 分钟(17:10 两条即两个作业同刻),无 401、无超时。17:10:03 的 cron 扫掠成功校准 10 个步骤、57 次调用。**实测调用量比按 `*/5` 折算的高**:17:06–17:39 共 33 分钟内 cron 8 次扫掠 522 次调用、webhook 68 次 155 次调用,合计约 1230 次/小时,约为 2500 警戒线的一半。多出来的扫掠来自 Actions 兜底作业的送达(它现在每次只扫一遍,但送达本身会叠在 `*/5` 之上)。若日后逼近警戒线,第一个可动的杠杆是把兜底作业的 `schedule` 放稀或让它只打 drain 不打 reconcile。密钥同时轮换过(旧值在 Vercel 上是 Sensitive、取不回来),新值只存在于 Vercel、GitHub Secret、Supabase Vault 和 `~/.config/pr-helper/cron-secret.txt`,未进仓库。只读凭据 `prh_readonly` 看不到 `cron` schema(`permission denied`),`net._http_response` 可读,后续核对走后者。

4. **drain 稳定后删掉 sweep 内联的执行路径已完成（无待办，仅留结论）**。自动化合并现在只有 drain 一条执行入口，sweep 改为信号源：门禁转绿时清 `failure_reason` 并 bump `updated_at`，否则合并延迟会从秒级掉到最长 30 分钟。`scheduleServerAutoCreate` 的内联创建有意保留（创建侧 `max(attempts)` 只有 3，套上 drain 那套规则拦不到东西）。方案与验收记录见 [`docs/superpowers/plans/2026-08-17-drop-inline-automation-execution.md`](superpowers/plans/2026-08-17-drop-inline-automation-execution.md)。

5. **自动化进度条 UI（只读部分已上线，写入路径仍后置）**。2026-08-15 先做了只读的可观测切片：`/api/inbox` 多带一个 `automation` 字段（复用看板已有的 30 秒轮询，不新增函数、不新增请求、不耗调用预算），受阻动作显示在失败中心、看板汇总条第四个计数、泳道步骤徽标、步骤抽屉明细和流程详情页 `stageTimeline` 五处；`automationActionPresentation` / `latestAutomationAction` 是五处共用的唯一判定。**2026-08-19 已上线只读进度条**：流程详情页时间线顶部一条整体进度条，节点状态由 `stageProgressNode` 从服务端 `decision` 与动作队列共同推出，不在浏览器重算；「已完成 n」只统计从第一步开始连续完成的前缀，因为服务端的 `merged` 描述的是该路径上一次的 PR 并会延续到下一轮，后面步骤留在上一轮的已完成显示为未开始，`merged` 且 `canCreateNext` 为真算就绪；进度条读的是服务端投影，故下方标注对账时间，且详情页 30 秒轮询会一并拉取投影（不带 `?refresh=1`，服务端只读库），刷新延迟等于服务端对账节奏；视觉上节点已合成一条铺满宽度的分段条而不是若干独立卡片；全部步骤完成时 `workflowProgress` 的 `currentIndex` 返回 `null`，不给任何节点加 `is-current`，标题改为「全部完成 · 共 N 步，等待新提交」——把已走完的最后一步标为当前步会让它看起来还在等操作。仍后置的是完整方案（[`docs/automated-workflow-plan.md`](automated-workflow-plan.md)《自动合并进度条》）中的步骤级放置、节点状态与方案表格的完全对齐，以及全部写入路径——接管对话框和 `unpause` 依赖第 1 项的「瞬时 vs 终态」分类，且生产至今没有任何一次 AI 生成失败可供验证。

6. **reconciliation 调用预算改为阈值观察（已从第一优先级降级）**。等峰值小时越过约 2,500 次再设计预算模型，依据见《2026-08-15 调用预算复核与 drain 实测》。**2026-08-18 复核**：常态 876–1,182 次/小时，历史峰值 1,702 次（08-17 23:00），占 5,000 次/小时基线的 18%–34%（08-15 记的 1,204 次已被此峰值取代）。同时更正方向：`degraded` 的约束是**时延不是调用数**——249 次让出里有只花 10–11 次调用就超时的样本（08-18 12:01 webhook、12:13 inbox_refresh），按调用数设上限治不到它；先做 ETag / `If-None-Match`（304 不计配额、往返也短），再按剩余时间预算切分单轮工作量。

7. private / organization 安装边界、Web Push、团队多账号协作、加密同步线上回归与数据保留 Cron：详见上方「依赖外部条件的待办」。
8. 完整发布回归：已通过 `feature → dev → main`、PR Actions、应用内合并与双平台 Preview/Production 部署跟踪；健康检查、失败部署投影和 Production 回滚仍待实测。 ⏳ 部分完成
9. 对 public、private、organization 仓库执行一轮 GitHub App 权限回归。 🟡 public 通过 / ⏳ private、organization 待验证
10. 失败恢复已由服务端校验重试次数、冷却时间、当前提交和失败 Actions；仍不自动修改代码或合并生产。
11. 加密云同步已接通密文上传/下载原型，仍需补齐密钥轮换、冲突处理和线上回归后再扩大使用范围。 🟡 待加固
12. 阶段状态、事件和部署历史已切换到稳定 `stage_id`。 ✅ 019 已执行，并已通过当前 Production 流程回归。
13. PR 流程自动化：服务端加密 AI 凭据、步骤级规则快照、`025` 运行快照/幂等动作队列和 `026` 自动化偏好已落地；Webhook、Cron 和 inbox reconciliation 会在 `ready-to-create` 自动入队，执行器会重校验统一阶段决策、服务端自动生成/确认、规则快照、新提交和开放 PR。自动创建 PR 受服务端凭据、AI 自动生成、自动确认和有效生成规则四项前置条件保护。合并后门禁与下一步解锁已经生效：`stageIsUnlocked` 要求前序步骤 `pull_state='merged'` 且 `checks_state='success'`，合并瞬间 `checks_state` 重置为 `pending` 由合并后 Actions 填回，`mergeChecksWithDeployments` 还把部署状态并入该字段。自动合并本身：`automationMergeOutcome` 只在 GitHub 判定 `mergeable=true` 且 `mergeable_state='clean'`、门禁全绿、审批达标时返回合并，其余一律 `paused`（含 `'behind'`，不自动 update branch）；`automationRetryIsExhausted` 按 `recoveryPolicy.maxRetries` 封顶重排；`merge-pr` 用独立幂等键，PR 已 merged 记幂等成功。方案与验收标准见 [`docs/automated-workflow-plan.md`](automated-workflow-plan.md)。🔴 2026-08-13 生产查询确认服务端自动创建实际未生效，原因链、修复方案与回归清单见 [`docs/auto-create-pr-remediation.md`](auto-create-pr-remediation.md)；其中 `P1`–`P6`（身份归一化、失败留痕、cron 分批、统一决策模型、执行器幂等化）已全部合入 `main` 并部署，`P3` 生产验收通过。`P8`（`workflow_automation_actions` 没有 `stage_index` 列，而执行器与队列列表都在 SELECT 它，执行器因此在原子领取动作之前抛错）已改为 JOIN `workflow_automation_runs` 取该列并部署生产，验证生效。`P9`（AI 响应的 markdown 围栏未被正确剥离，`trim()` 写在 `replace()` 之后导致锚点失配）已由 `jsonFromModelText` 修复并部署。✅ 2026-08-14 服务端自动创建 PR 在生产端到端跑通：自动建出 `bayernjf/bayjf#42`，动作 `succeeded` / `attempts=2` / `pullNumber=42`，后续轮转未重复建。✅ 2026-08-15 逐步骤自动合并在生产跑通：`create-pr` 47 次成功、`merge-pr` 37 次成功；10 次 `paused` 中 7 次是门禁未全绿的正确行为，另 3 次是 GitHub 超时（`71e6c4fb` 的尝试次数退还即针对这一类）。数据见《2026-08-15 生产实测结论》。✅ 2026-08-15 沙箱验完门禁为红场景：守卫落在合并侧（`paused` / `门禁尚未全绿`），创建侧因无 PR 时 `checks_state` 恒为 `unknown` 而不可达，原措辞应为「门禁为红不自动合并」；同一场景暴露 ruleset 里的审批要求不被读取（投影只查经典分支保护），已由 `requiredApprovalsFromProtection` 并行读取 `/rules/branches/{target}` 并取较严者修复。✅ 2026-08-15 沙箱验完幂等命中：动作在 `queued` 上等审批时 PR 被本人合掉，排空再执行时 `automationMergeOutcome` 在任何门禁判断之前返回 `idempotent`，跳过合并调用直接记 `succeeded`，审计留 `metadata.idempotent = true`；`mergedBy` 始终为本人而非 App。详见 remediation 第十七节。自动化验收清单至此无未验项。

### 2026-08-15 首页「需要处理」十项的核对

用户报「首页需要处理有十项，感觉有的不太对」。用生产数据把这十项复原后，确认 **9 项是错的，只有 1 项是真的**。

十项的来源是失败中心（`failureCenterPanel`）的三段之和：`actionQueue` 里的 `checks-failed` / `needs-approval`、部署失败、以及本次新加的受阻自动化动作。用生产 `workflow_stage_states` + 流程定义重放 `deriveStageDecision` / `actionableStageEntry`，`actionQueue` 只产出 2 项（`E2E Failure and Dynamic Rule` 的 `fix/failure-e2e` Actions 失败、`Private Repository E2E` 的 PR 已满足合并条件），其中只有前者进失败中心；部署失败 0 项。剩下 9 项全部是 `paused` 的自动化动作。

这 9 条逐条核对的结果是**全部已失效**：

| id | 路线 | 停在的原因 | 更新的同路线动作 |
| --- | --- | --- | --- |
| 11 / 15 / 99 | pr-helper `feature/20260722` | 门禁尚未全绿 | 18 / 17 / 8 条，含多条 `succeeded` |
| 13 | pr-helper `dev` | 门禁尚未全绿 | 16 条，含多条 `succeeded` |
| 20 | agent-dev `feature/20260802` | 门禁尚未全绿 | 1 条 `succeeded` |
| 22 / 71 | word-base `feature/20260604` | 门禁尚未全绿 | 3 / 2 条，含 `succeeded` |
| 58 | pr-helper-landing `dev` | `CONNECT_TIMEOUT` | 1 条 `succeeded` |
| 80 | termana-landing `dev` | GitHub 请求超时 | 1 条 `succeeded` |

也就是说每一条都已被同一路线上更新的动作取代，且取代它的那条都已经成功——对应的 PR 早已合并。

**根因在 08-15 新加的 `paused` 分支的判断顺序**：它先看失败原因，GitHub 已给出裁决的行直接 `skip`，因此永远走不到 `hasNewer` 那一步；而 `queued` / `running` 早就有 `superseded` 的退出口，`paused` 没有。修复是把 `hasNewer` 提到该分支的第一条并判 `cancel / superseded`。这同时纠正了「裁决要留作操作者的记录」这条理由的适用范围：只有最新那条才是记录，被取代的那条不是。

修复上线后失败中心应只剩 1 项（`fix/failure-e2e` 的 Actions 失败），9 条 `paused` 会被清成 `cancelled / 已被后续提交的自动化动作取代`，仍可在历史里查到。看板「已暂停，需要处理」计数应从 9 归零。

**2026-08-15 14:50 部署后核对已确认**：九条在同一个 drain 批次里被清成 `cancelled / 已被后续提交的自动化动作取代`（约 0.75 秒一条，批量上限 10），库里已无任何 `paused` 行，失败中心只剩那 1 项真待办。

### 2026-08-15 实时校准预算的实测重定

近 24 小时 `reconciliation_runs` 按触发方分组（UTC）：

| trigger | success | degraded | failure | success p50 / p90 / max | degraded 时长 | degraded 中已校准/总步骤 |
| --- | --- | --- | --- | --- | --- | --- |
| `cron` | 179 | 1 | 0 | 13.4s / 22.6s / 38.1s | 13.8s | 9 / 10 |
| `webhook` | 272 | 142 | 25 | 7.9s / 9.5s / 11.4s | 9.86–16.4s | 44 / 195 |
| `manual` | 30 | 35 | 2 | 8.0s / 10.1s / 17.5s | 9.86–41.2s | 13 / 53 |
| `inbox_refresh` | 2 | 3 | 0 | 6.3s / 8.0s / 8.0s | 9.87–10.0s | 2 / 6 |

三条结论：

- **8 秒装不下一个步骤。** webhook 与 manual 的 sweep 只覆盖 1–2 个步骤，成功的 p50 已是 7.9 秒，也就是单个步骤的 GitHub 往返本身就接近整份预算。于是 34% 的投递和 54% 的保存在让出，webhook 让出的 195 个步骤里有 151 个白做——这正是 PR #240 合并后第 1 步骤投影停在旧 PR #238 约 10 分钟的机制：每次触发都在到达该步骤前让出。
- **让出的耗时全部落在 9.86 秒以上，不是 8 秒。** 租约获取与前后查询在预算之外，约 1.9 秒；调预算时要按这个口径算，不能只看常数。
- **外层兜底会甩掉活着的 sweep。** webhook 让出耗时最大 16.4 秒，正好压在 `budgetMs * 2` = 16 秒上；被甩掉的 sweep 无人收尾，`reconciliation_runs` 留下 `running` 行，5 分钟宽限后被下一次 cron 记为 `校准中断：函数实例在完成前被回收`——24 小时内 25 条 webhook `failure` 就是这么来的（最小时长 391 秒 = 300 秒宽限 + 发现延迟，全部 0 步骤已校准）。

原计划里「把两种 degraded 结局在遥测里分清楚」这一条不必做：查询已能区分——预算内让出记 `degraded` + `校准未在预算内完成，已让给下一次触发`，实例被回收记 `failure` + `校准中断：函数实例在完成前被回收`。上表就是用这一区分算出来的。

部署后用同一组查询复核：`webhook` 的 degraded 占比应从 34% 明显下降，`failure` 应趋近于 0；`manual` / `inbox_refresh` 的 p90 不应上升。

### 2026-08-15 排空器首次真实执行与 stale 窗口的结构性缺陷

bigint 身份修复（`6aa011c2`）部署后，12:36–13:11 之间 `id 113`–`121` 共 8 条动作 `succeeded`（`attempts` 1–3），`id 111` 被判 `superseded` 而 `cancelled`。这是排空器上线以来第一次真正执行动作，此前「`executed: 0`」并非队列为空，而是每一行都在原子领取之前抛错。

同一次核查暴露出一个独立的结构性缺陷：`paused` 没有任何重排入口。`id 6`（21 小时）、`58`（14 小时）、`80`（12.3 小时）都是瞬时网络故障（GitHub 超时、`write CONNECT_TIMEOUT`），它们不是重试次数耗尽，而是从未被重试，一直躺到超过 `AUTOMATION_ACTION_STALE_MS`（12 小时），只能被 sweep 按超时清掉。`id 84` 被人工重排时已过窗口 30 秒，是同一缺陷的第二个样本。修法见「下一阶段优先级」第 1 项。

### 八、非验收类后续开发

以下事项不阻塞 018，也不需要在当前阶段追加 SQL，但属于后续应继续推进的工程和产品工作：

- **正式切换稳定阶段身份**：`019` 已将核心主键、外键和查询条件从 `stage_index` 切换到 `stage_id`；待 Preview 回归。
- **并发与幂等保护**：为流程版本保存增加并发控制，并为创建 PR、合并、Actions 重试和回滚补充幂等键、CSRF 防护和限流。
- **完整操作审计**：`020` 已执行；创建/合并 PR、流程保存/删除、Actions 重跑和部署回滚的成功/失败结果记录已实现。Production 已显示真实流程更新、创建/合并 PR 记录，CSV 导出按钮可用。✅
- **浏览器 E2E**：已覆盖授权返回、新建/编辑流程、步骤排序、失败恢复、抽屉创建/合并 PR、删除流程和确认式回滚；Webhook 自动投影已通过真实 GitHub delivery 验收。
- **加密同步加固**：已部署 v2 密文格式、v1 兼容读取、口令轮换、设备标识和乐观版本冲突拒绝；`021` 已执行，待线上回归。
- **数据保留与清理**：已部署 Webhook、密文历史、reconciliation、事件、部署运行和审计日志的 30/90/180/365 天保留策略；现有 Cron 每次受限清理 2,000 条，`022` 已执行，待运行观察。
- **团队协作闭环**：已部署团队管理界面、成员角色更新/移除、流程共享、共享流程投影和服务端角色强制执行；`023` 已执行。实际多账号协作与 GitHub App 安装边界仍需 Production 验收。
- **reconciliation 调用预算（已降级为阈值观察）**：`github_calls` / `github_ms` 遥测已上线；按小时复核后峰值只占基线的 18%–34%，且真正的约束是单次 GitHub 往返的时延而非调用数，触发条件与依据见「下一阶段优先级」第 6 项。
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
