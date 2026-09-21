# A2A Agent Card 与封臣声明（fealty）

> 状态：现行（2026-09-21）。pr-helper 作为 Zeus 的**第一个封臣**，本文件记录其对外发布的 Agent Card 与封臣契约。协议设计全文见 zeus 仓库 `docs/design-vassal-protocol.md`。

## 发布内容

- **卡片单一事实源**：`api/_lib/agent-card.ts` 的 `buildAgentCard()`；修改能力声明只改这里。
- **端点**：`GET /api/a2a/agent-card`（Vercel serverless，`api/a2a/agent-card.ts`）。
- **well-known 路径**：`/.well-known/agent-card.json` 与 `/.well-known/agent.json` 由 `vercel.json` rewrite 指向上述端点，供标准 A2A 客户端发现。
- **本地开发**：`api/` 仅在 Vercel 运行时生效，本地 `npm run dev` 不暴露该端点；用 `vercel dev` 或部署后验证。

## 能力声明（skills）

`create-pr` / `merge-pr` / `rerun-actions` / `deployment-health` / `production-rollback`。

## 封臣契约（x-zeus-fealty）

| 字段 | 值 | 说明 |
| --- | --- | --- |
| swornTo | zeus | 唯一效忠对象，星型拓扑，不与封臣直连 |
| domain | pr-release-control | 能力域，Zeus 据此路由 |
| dataRealms | enterprise | 只服务企业数据域任务 |
| dataPolicy | read-task-scope | 只读任务范围内的数据 |
| reportBack | true | 承诺战报回流（summary/evidence/cost） |
| escalationPolicy | auto | 不可逆操作一律升级驾驶员 |
| sla.ackSeconds | 5 | 受理时限 |

**与产品安全规则的关系**：AGENTS.md 规则 5 要求 Production merge/rollback 必须是显式用户操作——这恰好由 `escalationPolicy: auto` 承接，不冲突。卡片如实声明 streaming/push 均为 false，任务执行（tasks/send）尚未实现，当前仅发布发现与契约。

## 下一步（对照 zeus 验收清单）

1. ~~Agent Card + fealty 发布~~ ✅
2. `tasks/sendSubscribe` 全流程
3. 战报回流三字段
4. escalation：force-push 等场景走 input-required
5. Zeus 派发侧脱敏/吊销/审计
6. 纯标准 A2A 客户端可调用（守护测试）
