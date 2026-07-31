# PR Helper 产品定位与落地页思路

## 一句话定位

> AI 驱动的 PR / Release Control Tower：把多个仓库、多个发布链路和等待中的门禁，收敛成只在需要你决策时才打断你的工作台。

PR Helper 不是一个“创建 PR 的表单”，也不是 Claude Code 或 Codex 的替代品。它负责持续编排和监控发布流程；AI 编码 Agent 负责写代码、修复问题和执行具体工程任务。

## 用户问题

一个开发者同时维护多个仓库、多个功能和多条发布链路时，通常需要反复在 GitHub 标签页之间切换：

- 功能测试完成后，要判断 `feature → dev` 是否已有 PR、是否有新提交。
- 合并后要等待 GitHub Actions，再到预览环境验证。
- 预览验证通过后，才能继续 `dev → main`。
- 任一步的 Actions、审批或门禁失败，都可能让后续阶段不能继续。
- CI 失败时，需要重新寻找日志、打开 Agent、说明仓库、分支和错误上下文。

真正的痛点不是“不会创建 PR”，而是发布链路的状态分散、等待不可见、下一步不明确，持续打断开发者的注意力。

## 为什么不是直接用 GitHub、Claude 或 Codex

| 工作 | GitHub / Claude / Codex 可以做 | PR Helper 的价值 |
| --- | --- | --- |
| 创建一条 PR | GitHub 原生完成；Agent 也可调用 API | 复用真实仓库分支和预设的有序链路。 |
| 写代码、提交、push、修 CI | Claude Code / Codex 擅长 | 不是竞争对象；应把失败上下文交给 Agent。 |
| 查看单个 PR 的 Checks | GitHub 页面可查看 | 聚合多个仓库、多个阶段的“待处理事项”。 |
| 合并后等待 Actions | GitHub 各页面分散显示 | 监控后续验证，并阻止后序阶段被错误放行。 |
| 维护团队流程 | 靠口头约定、分支保护和多个页面 | 把真实分支路径、门禁、审批和确认步骤显式化。 |

结论：Agent 解决“如何完成一次工程操作”；PR Helper 解决“此刻所有发布链路中，什么事情值得我处理，以及下一步是什么”。

## 核心产品闭环

```text
GitHub PR / Actions / Review / Webhook
              ↓
PR Helper 读取并判断每个流程阶段
              ↓
┌─────────────┼─────────────────────────┐
↓             ↓                         ↓
CI 失败       所有门禁通过               需要人工判断
↓             ↓                         ↓
交给 Codex    解锁下一阶段 / 提醒合并     通知用户并给出上下文
↓             ↓                         ↓
新 PR 或修复  继续 feature → dev → main   记录确认和决策
```

长期目标是让用户只看到需要决策的事项，而不是持续盯着所有 GitHub Actions。

## 当前已交付的产品闭环

- 基于真实 GitHub 仓库和分支配置流程，例如 `feature → dev → main`。
- 使用多项目 Lane 看板展示当前执行位置、待办、失败和最近动态，并支持拖拽排序。
- 支持 `feature/*`、`fix/*` 等动态来源、多分支汇聚到同一目标分支，以及下游汇聚门禁。
- 在 Lane 步骤抽屉中创建 PR、执行 merge commit、查看原生 GitHub 页面和重跑失败 Actions。
- 按 GitHub 实际存在的门禁读取 Checks、Commit Status、Approval、mergeability、分支保护和合并后 Actions。
- 通过 Webhook 和定时 reconciliation 持续校准状态；Web Push 可在页面关闭后发送通知。
- AI 流式生成 PR 标题和描述，覆盖前确认，并保存 24 小时本地草稿。
- Markdown 生成规则支持新增、编辑、导入、默认规则和每次 PR 单选。
- GitHub App 授权访问 private、public 与 organization 仓库；流程和运行状态按 GitHub 用户持久化到 Supabase。
- 跟踪 Vercel / Cloudflare Preview 与 Production 部署、健康检查、失败详情和最近运行历史。
- 成功的 Production 部署可在用户确认后通过 GitHub Actions 回滚，GitHub Environment 仍保留最终保护。
- 流程版本快照：每次保存流程自动生成版本，PR 合并时记录运行实例，Overview 看板展示最近运行历史。
- 发布历史时间线：聚合 PR 检测、合并、Checks、部署、回滚和 Actions 重跑事件，每个项目和步骤显示可追溯时间线。
- 失败处理中心：Overview 顶部集中展示所有失败项，提供一键重试、Codex 修复和查看详情。
- 流程预检：一键检查 App 权限、分支存在性、PR 冲突、上游依赖、Actions 和 Environment 配置，每项给出修复建议。
- 失败恢复策略：Actions 重试次数限制、冷却时间和人工升级提示，每个项目可自定义策略，防止无限重试并引导人工介入。
- 加密云同步（原型）：AES-GCM 256 位加密 + 口令派生密钥，服务器仅存储密文，支持上传/下载；密钥轮换和冲突处理仍待加固。
- Actions 重试由服务端校验次数、冷却时间和当前提交后执行，GitHub 代理限制在产品所需路径和 HTTP 方法内。

当前产品已超过纯浏览器 Mock MVP，处于需要完成真实发布回归和运维可观测性的阶段。实时架构与边界见 [`current-state.md`](current-state.md)。

## 下一阶段优先级

核心编排闭环已建立，接下来优先增强可靠性，而不是继续堆叠流程模板。

> 详细待执行/待验证清单见 [`current-state.md`](current-state.md) 「待执行与待验证清单」章节。

1. **稳定阶段身份部署**：`014`–`019` 已执行并完成迁移；先部署 Preview 验证稳定 `stage_id` 查询和历史时间线，再推进 `dev`/`main`。 ⏳ 待执行
2. **线上回归**：完整验证 `feature → dev → main`、合并后 Actions、双平台部署和 Production 回滚。 ⏳ 待验证
3. **权限回归**：持续验证 public、private、organization 仓库以及 GitHub App 权限更新后的行为。 ⏳ 待验证
4. **安全云同步**：已实现加密上传/下载原型（AES-GCM + PBKDF2），待密钥轮换、冲突处理和线上验证。 🟡 待加固
5. **流程预检 + 失败恢复**：已交付，待线上验证；后续补充幂等、限流和更完整的操作审计。 🟡 待加固
6. **稳定阶段身份正式切换**：`019_stage_identity_primary_keys.sql` 已执行，服务端从 `stage_index` 切换到 `stage_id`，待 Preview 回归。 🟡 待验证
7. **统一服务端状态模型**：由服务端输出阶段决策，前端只负责展示和操作，减少跨页面状态不一致。 🟡 待加固
8. **浏览器 E2E 与安全保护**：覆盖高风险 UI 链路，并补充并发控制、幂等、CSRF 和限流。 🟡 待加固
9. **审计、保留和团队权限**：完善操作审计、历史数据清理，以及团队/角色/项目级权限。 ⏳ 后续规划

## 非目标

- 不取代 GitHub 的代码审查、分支保护和 Environment protection；PR Helper 可以发起受 GitHub 原生规则约束的 merge commit。
- 不把 GitHub token、GitHub App installation token 暴露给浏览器。
- 不试图成为通用代码编辑器或直接和 Coding Agent 竞争。
- 不在未经明确授权时自动合并到生产分支。

## 落地页叙事建议

### Hero

主标题：**让发布流程等你决策，而不是让你盯着 GitHub。**

副标题：配置 `feature → dev → main` 等真实分支链路。PR Helper 持续跟踪 PR、Actions、审批与预览验证，只在下一步需要你时提醒你。

主 CTA：**使用 GitHub 连接**

辅助信任文案：支持 private、public 与 organization 仓库；GitHub App 授权；不在浏览器保存生产访问令牌。

### 问题展示

用三个短场景替代功能堆砌：

1. “我这个 feature 到底有没有合进 dev？”
2. “哪个仓库的 CI 失败了，哪个可以继续发？”
3. “我修完 CI 后，下一步该提 PR、等审批还是合并？”

### 工作方式展示

以 `feature/payment → dev → main` 的一条时间线展示：

1. 选择真实仓库和分支，保存可复用流程。
2. 创建 PR，查看原生 GitHub 页面或在 PR Helper 中监控门禁。
3. Actions、审批和配置的 Preview/Production 部署门禁全部通过后，自动解锁下一步。
4. 失败时，把完整上下文交给 AI Agent 修复。

### 对比区

避免攻击 GitHub 或 Agent。表达为：

- GitHub 是代码协作与事实来源。
- Codex / Claude 是工程执行者。
- PR Helper 是跨仓库发布流程的控制台。

### 最终 CTA

**从第一条发布链路开始。**

连接 GitHub，选择一个仓库，配置真实的 Source、Target 和后续步骤。
