# A2A Agent Card 与封臣声明（fealty）

> 状态：现行（2026-09-21）。pr-helper 作为 Zeus 的**第一个封臣**，本文件记录其对外发布的 Agent Card、封臣契约与任务执行接口。协议设计全文见 zeus 仓库 `docs/design-vassal-protocol.md`。

## 发布内容

- **卡片单一事实源**：`api/_lib/agent-card.ts` 的 `buildAgentCard()`；修改能力声明只改这里。
- **发现端点**：`GET /api/a2a/agent-card`（Vercel serverless，`api/a2a/agent-card.ts`）。
- **任务端点**：`POST /api/a2a/tasks`（`api/a2a/tasks.ts`），JSON-RPC 2.0：`tasks/send` / `tasks/sendSubscribe`（SSE 流式）/ `tasks/get` / `tasks/cancel`。
- **well-known 路径**：`/.well-known/agent-card.json` 与 `/.well-known/agent.json` 由 `vercel.json` rewrite 指向卡片端点。
- **认证**：设置环境变量 `ZEUS_A2A_TOKEN` 后，任务端点要求 `Authorization: Bearer <token>`；未设置则放行（开发模式）。
- **本地开发**：`api/` 仅在 Vercel 运行时生效，本地 `npm run dev` 不暴露该端点；用 `vercel dev` 或部署后验证。

## 能力声明（skills）

`create-pr` / `merge-pr` / `rerun-actions` / `deployment-health` / `production-rollback`。

执行语义：每个 skill 都支持 **plan 模式**（默认，返回带 `x-zeus-report` 的行动方案 artifact，状态 completed）与 **execute 模式**（`mode: "execute"`）：
- execute 模式目前返回 input-required——真实执行需要 Zeus 委派的 GitHub 凭据，凭据委派尚未实现（诚实声明，不做虚假完成）。
- 不可逆 skill（merge-pr、production-rollback）在 execute 模式一律升级驾驶员（`x-zeus-escalation`），与 AGENTS.md 安全规则 5 一致。

消息格式：data part `{ "kind": "data", "data": { "skill": "create-pr", "owner": "...", "repo": "...", ... } }`；Zeus 注入的 `x-zeus-runId`（message.metadata）会在每个事件回显。

## 封臣契约（x-zeus-fealty）

| 字段 | 值 | 说明 |
| --- | --- | --- |
| swornTo | zeus | 唯一效忠对象，星型拓扑，不与封臣直连 |
| domain | pr-release-control | 能力域，Zeus 据此路由 |
| dataRealms | enterprise | 只服务企业数据域任务 |
| dataPolicy | read-task-scope | 只读任务范围内的数据 |
| reportBack | true | 战报回流：每个完成 artifact 携带 summary/evidence/cost/followUps |
| escalationPolicy | auto | 不可逆操作一律升级驾驶员 |
| sla.ackSeconds | 5 | 受理时限 |

## 已知限制

- **任务存储为实例内存**（30 分钟 TTL，500 条上限）：任务在单次请求内同步执行完成，`tasks/sendSubscribe` 的完整事件流在同一次调用中返回；跨调用的 `tasks/get`/`tasks/cancel` 在同一实例内有效，属尽力而为。跨实例持久化（Supabase）待立项。
- **execute 模式需要凭据委派**：Zeus 委派 GitHub installation token 的机制未实现。

## 验收清单（对照 zeus design-vassal-protocol.md §7）

1. ~~Agent Card + fealty 发布~~ ✅
2. ~~`tasks/sendSubscribe` 全流程~~ ✅（受理→working→completed/failed，14 项单测覆盖）
3. ~~战报回流三字段~~ ✅（summary/evidence/cost，plan artifact 上）
4. ~~escalation：不可逆场景走 input-required~~ ✅（merge-pr、production-rollback）
5. Zeus 派发侧：脱敏、吊销 token、审计——待 Zeus 侧实现
6. 纯标准 A2A 客户端可调用（守护测试）——待部署后真机验证

## 调用示例

```bash
# 发现
curl -s https://<host>/.well-known/agent-card.json | jq .

# 同步执行（plan 模式）
curl -s -X POST https://<host>/api/a2a/tasks -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "tasks/send",
  "params": { "message": { "role": "user", "metadata": { "x-zeus-runId": "zeus-run-123" },
    "parts": [ { "kind": "data", "data": { "skill": "create-pr", "owner": "acme", "repo": "app", "head": "feat/x", "base": "main" } } ] } } }' | jq .

# 流式执行
curl -N -X POST https://<host>/api/a2a/tasks -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 2, "method": "tasks/sendSubscribe",
  "params": { "message": { "role": "user", "parts": [ { "kind": "data", "data": { "skill": "production-rollback", "owner": "acme", "repo": "app", "environment": "production", "mode": "execute" } } ] } } }'
```
