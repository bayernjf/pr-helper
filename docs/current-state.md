# PR Helper 当前状态

> 最后更新：2026-07-30
> 本文是当前架构、功能边界和下一阶段工作的事实来源。`docs/superpowers/specs/` 与 `docs/superpowers/plans/` 保存历史决策和实施过程，不作为当前 backlog。

## 产品形态

PR Helper 是 GitHub-first 的 PR / Release Control Tower。用户以项目 Lane 组织仓库，为每个项目配置真实的 Source → Target 合并路径，并在同一看板中完成 PR 创建、门禁跟踪、合并、部署验证和失败恢复。

当前流程支持：

- 线性链路，例如 `feature/* → dev → main`。
- 独立合并路径，例如 `feature/* → dev` 与 `fix/* → dev`。
- 多路径汇聚门禁：下游步骤可等待多个上游路径全部合并且合并后检查成功。
- Lane 上下拖动、键盘/按钮排序和项目状态筛选。

当前不提供任意 DAG 编辑器、流程模板市场或未经确认的生产自动合并。

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

### AI 与本地草稿

- OpenAI Chat Completions 兼容 SSE 流式生成 PR 标题和描述。
- 已有内容时覆盖前确认；生成和手写内容按仓库/Source/Target 保存 24 小时。
- Markdown 生成规则支持新增、编辑、导入、默认规则和单选。
- AI API Key 仅保存在浏览器会话；PR 草稿和生成规则仍是浏览器本地数据，不跨设备同步。

### 监控、通知与失败恢复

- GitHub Webhook 签名校验、delivery 去重和数据库投影。
- 定时 reconciliation 补偿漏掉或乱序的事件。
- 服务端待办队列覆盖 Actions 失败、待审批、可合并和可创建下一 PR。
- Web Push + Service Worker 支持页面关闭后的通知；浏览器权限与 VAPID 配置仍是前提。
- 失败 Actions 可重跑，并可生成包含 PR、失败 Job、错误摘要与文件 diff 的 Codex 修复包。

### 公网部署

- 按项目和目标分支选择 Vercel / Cloudflare Pages GitHub Actions 工作流。
- 合并后跟踪 Preview/Production Actions，全部成功后才解锁下游步骤。
- 可选 HTTPS 健康检查、失败 Job 摘要、重新部署、最近 8 次运行历史。
- 编辑器与 Lane 显示 Actions 权限、工作流名称、GitHub Environment、健康路径和运行超时问题。
- `bayernjf/pr-helper` 的标准 Production 部署已绑定 `Rollback frontend deployment`；回滚必须由用户确认并再次经过 GitHub Environment 规则。

## 数据边界

| 数据 | 存储位置 |
| --- | --- |
| GitHub 登录、installation id | 签名 HTTP-only session + Supabase 用户记录 |
| GitHub App private key、OAuth secret、installation token | 仅服务端；installation token 短期生成，不进浏览器和数据库 |
| 流程配置、阶段状态、事件、部署历史 | Supabase Postgres |
| Push subscription | Supabase Postgres |
| AI API Key | 浏览器 `sessionStorage` |
| PR 草稿、Markdown 生成规则 | 浏览器 `localStorage` |

数据库迁移的当前基线是 `001`–`013`。迁移必须按编号在 Supabase SQL Editor 或独立 migration job 中执行；运行时 API 不创建或修改表。

## 当前运维边界

- GitHub App 的 `Actions` 权限需要 **Read & write**，用于读取运行状态、重跑失败 Actions 和触发回滚工作流。
- GitHub 分支保护、审批要求和 Environment protection 始终由 GitHub 原生强制执行。
- Production 回滚只接受成功的 `main` 部署及不可变平台部署 URL；Preview 不提供回滚。
- Cloudflare Pages 不承载本项目的 GitHub App session/API；其静态页面依赖 Vercel canonical origin。

## 下一阶段优先级

1. 将当前功能完整发布到 `dev`/`main`，完成 Vercel 与 Cloudflare Production 回滚实测。
2. 对 public、private、organization 仓库执行一轮 GitHub App 权限回归。
3. 增加服务端监控可观测性：Webhook/cron 延迟、失败率、最近一次成功校准时间。
4. 完善失败恢复：可配置重试次数、冷却时间和人工升级策略，仍不自动修改代码或合并生产。
5. 评估生成规则与 PR 草稿的加密云同步；在密钥管理方案明确前继续保持本地存储。

## 文档维护规则

- 当前事实优先更新本文、根目录 `README.md`、`AGENTS.md` 和 `db/README.md`。
- 历史规格和实施计划保留原始假设；若已完成或被替代，在文件顶部写明状态并链接到本文。
- 历史计划中的未勾选项不自动等于当前 backlog。
