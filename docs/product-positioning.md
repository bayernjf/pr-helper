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
| 维护团队流程 | 靠口头约定、分支保护和多个页面 | 把流程模板、门禁、审批和确认步骤显式化。 |

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

## 现阶段 MVP 已验证的内容

- 基于真实 GitHub 仓库和分支配置流程，例如 `feature → dev → main`。
- 按顺序创建 PR，并链接到原生 GitHub PR / Compare 页面。
- 读取 PR、Actions、Approval、合并可行性和合并后验证状态。
- 阻止前序 PR 未合并、合并后 Actions 未成功或未完成预览确认时的后续步骤。
- AI 自定义模型生成 PR 标题和描述。
- GitHub App 授权访问 private、public 与 organization 仓库。
- GitHub 用户级流程持久化基础。

## 产品护城河与优先级

仅有“创建 PR + 看 Actions”不足以形成产品价值。下一阶段优先级应是：

1. **后端持续监控**：GitHub Webhook、持久化状态与关闭页面后的通知，而非只靠前端轮询。
2. **全局待办队列**：跨仓库显示“CI 失败”“等待审批”“可合并”“可创建下一阶段”，按需要处理的优先级排序。
3. **AI 修复交接**：Actions 失败时，将仓库、分支、PR、失败日志、流程位置和预期结果一键交给 Codex / Claude Code。
4. **自动推进建议**：Actions 全绿或审批满足时，解锁下一步；保持人对合并和生产发布的最终控制。
5. **团队流程治理**：共享模板、发布确认、权限、审计记录和环境策略。

## 非目标

- 不取代 GitHub 的代码审查和最终合并界面。
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
3. Actions 全绿、审批和预览确认后，自动解锁下一步。
4. 失败时，把完整上下文交给 AI Agent 修复。

### 对比区

避免攻击 GitHub 或 Agent。表达为：

- GitHub 是代码协作与事实来源。
- Codex / Claude 是工程执行者。
- PR Helper 是跨仓库发布流程的控制台。

### 最终 CTA

**从第一条发布链路开始。**

连接 GitHub，选择一个仓库，配置真实的 Source、Target 和后续步骤。
