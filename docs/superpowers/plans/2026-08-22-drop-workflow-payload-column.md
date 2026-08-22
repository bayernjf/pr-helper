# 删除 `pr_helper_workflows.payload` 列（2026-08-22，方案）

本文只是方案。**尚未实施，也不建议在 2026-08-28 之前实施**——是否落地由那天的一周 Supabase Usage 结论一并决定。

- 上游待办：[`handoff.md`](../../../handoff.md) 「后续待办」第 1 条末句「剩下 `payload` 列删除一项独立步骤」。
- 方案母文档：[`docs/supabase-egress-optimization.md`](../../supabase-egress-optimization.md)（expand → migrate → contract 的第五轮）。
- 已落地的前序步骤：迁移 `036`（expand）、`037`（回填 + 一致性校验）、`038`（读切换，把 `name` / `repository` 收紧为 `NOT NULL`）、`039`（删掉死的 jsonb 表达式索引）、`040`（提示词内容契约化）；以及 2026-08-22 的《`version` 接入乐观锁》。

---

## 一、先说结论：这一步不是为了出站量

母文档自己的实测已经把账算清了，这里如实复述，避免把它当成省流量的收尾：

| 读点形态 | 数量 | 删列的出站影响 |
| --- | --- | --- |
| 主键单行读（每次约 1.5 kB payload） | 7 | 省下的字节可忽略；换成 10 个标量列 + 2 个 `jsonb_agg` 子查询后**可能反而略增** |
| 列表读（浏览器最终要整个对象） | 7 | 基本等量搬运，`jsonb_agg` 的 `to_jsonb(row)` 带上列名，**大概率比 payload 更大** |

真实收益只有三项，都不是流量：

1. **消除双表示漂移**。今天同一份流程同时活在 `payload` 与「promoted 列 + `workflow_stages` + `workflow_deployment_configs`」里，靠 `workflowToRows` / `workflowFromRows` 的恒等测试和 `037` 的一次性校验维持一致。删列之后只剩一份真相，漂移这类 bug 从「要靠测试防住」变成「不可表示」。
2. **每次保存少写一份完整 JSON**。`upsertWorkflow` 与 `removeWorkflowStage` 现在各写一次 payload，再由 `writeWorkflowRows` 写一遍关系表。
3. **存储**。35 行约 70.8 kB。注意 `workflow_versions.snapshot` 仍是每个版本一份完整副本，且 `040` 已确认**全代码库没有任何读者**——如果目标是存储，那一块比这一列大得多，但它是另一件事，不欠这一步。

**因此这一步的正当理由是「收口双表示」，不是「省 Egress」。** 如果 8/28 的 Usage 结论是「已经够用了」，那也不构成放弃它的理由；反之，如果结论是「还差得远」，它也救不了场。

## 二、读点清单（14 处，全部在 `api/_lib/workflows-store.ts`）

`storedWorkflowFromPayload(` 共 15 个命中，其中 1271 行是函数定义本身，剩 14 处是读点。**母文档写的「两个文件」已过期**：[`api/_lib/preflight.ts`](../../../api/_lib/preflight.ts) 现在没有读点。

### 2.1 第一批：主键单行读（7 处）

| 行 | 所在函数 | 备注 |
| --- | --- | --- |
| 559 | `executeWorkflowAutomationActionForUser` | drain 领取动作后读流程定义 |
| 1355 | `workflowAccessForUser`（自有） | 几乎所有写操作的前置 |
| 1368 | `workflowAccessForUser`（共享） | 同上，走 team join |
| 1608 | `upsertWorkflow` | 读 `previous`，**在事务外、advisory lock 之前** |
| 1672 | `removeWorkflowStage` | `SELECT payload, version ... FOR UPDATE` |
| 1702 | `removeWorkflow` | |
| 2604 | `recordWorkflowRun` | |

### 2.2 第二批：列表读（7 处）

| 行 | 所在函数 | 备注 |
| --- | --- | --- |
| 1532 | `listWorkflows`（自有） | 唯一接 `hydrateGenerationRules` 的读点 |
| 1539 | `listWorkflows`（共享） | 同上 |
| 2461 | `listWorkflowStageStates` | |
| 2511 | `listWorkflowConfigurationWarnings` | |
| 2539 | `listActionableStages` | |
| 2562 | `listRecoveryStatuses` | |
| 2707 | `listWorkflowTimeline` | |

### 2.3 已经现成的机械

`038` 留下的三件东西可以直接复用，不需要新写映射：

- [`TrackedWorkflowRow`](../../../api/_lib/workflows-store.ts)（633 行）——行的类型。
- `trackedWorkflowColumns(sql)`（643 行）——列清单 + 两个 `jsonb_agg` 子查询，别名固定为 `workflows.`。
- `trackedWorkflowFromRow(row)`（649 行）——包一层 `workflowFromRows`。

也就是说每个读点的改动形状都一样：把 `SELECT payload` 换成 `SELECT ${trackedWorkflowColumns(sql)}`，把 `storedWorkflowFromPayload(row.payload)` 换成 `trackedWorkflowFromRow(row)`。**是机械改动，不是重写。**

## 三、写点（2 处）与列的 `NOT NULL`

写 payload 只有两处：1628 行 `upsertWorkflow` 的 `INSERT ... ON CONFLICT`，1681 行 `removeWorkflowStage` 的 `UPDATE`。

两个必须提前知道的约束（已用只读通道核实，不是记忆）：

1. **`payload` 是 `NOT NULL` 且无默认值。** 所以「代码停止写 payload」不能先于一次 `ALTER COLUMN payload DROP NOT NULL`，否则每次新建流程的 `INSERT` 当场失败。
2. **`writeWorkflowRows` 只做 `UPDATE`，不做 `INSERT`。** 建行完全依赖 1628 行那条 `INSERT`。所以停写 payload 的同一步，必须把 `workflowToRows` 产出的全部列搬进这条 `INSERT`（今天它只带 `name` / `repository`，其余列靠随后的 `UPDATE` 补齐），否则新建的流程会缺 `archived` / `version` / `position` 等列。这是本方案里唯一一处**不是**机械改动的地方。

## 四、分步与顺序

严格 expand → contract，每一步单独部署、单独验收，任意一步都可以只回滚代码。

| 步 | 内容 | 可回滚性 | 时点 |
| --- | --- | --- | --- |
| A | 切第一批 7 处主键单行读 | 纯代码，`git revert` 即回滚 | 可在 8/28 前做（若批准） |
| B | 切第二批 7 处列表读 | 纯代码 | A 稳定后 |
| C | 迁移：`ALTER TABLE pr_helper_workflows ALTER COLUMN payload DROP NOT NULL` | 无损，可再 `SET NOT NULL` | B 稳定后 |
| D | 代码停止写 payload（含第三节第 2 点的 `INSERT` 补列） | 纯代码 | C 之后 |
| E | 迁移：`ALTER TABLE pr_helper_workflows DROP COLUMN payload` | **单向门** | D 观察满一周后 |

**E 是本方案唯一不可逆的一步。** 列一删，任何仍读 payload 的旧 Vercel 部署都不能再回滚上线——`handoff.md` 已有「不要为了验收立即触发 Production 回滚」的约束，这里再加一条：E 之前要确认没有需要保留的回滚目标。若不确定，E 可以无限期推迟，A–D 的收益（少写一份 JSON、读路径单一真相）已经全部到手，**E 只是省 70.8 kB 存储**。

母文档的门禁「收缩迁移只在读路径完全切换并观察一周后才应用」：`038` 于 2026-08-21 落地，故最早 2026-08-28 才谈得上 C；E 还要再加一周。

## 五、具体陷阱（这一节是本文的价值所在）

1. **`trackedWorkflowFromRow` 在 `stages` 为空时返回 `null` 并 `console.error`。** 单行读点若照抄，「流程不存在」和「镜像缺失」会收敛成同一个结果，而现有调用方的文案是「未找到对应流程」。镜像缺失是 bug，不该被报成用户错误。第一批每个读点都要显式区分：`rows.length === 0` 才是「不存在」。
2. **1672 行的 `FOR UPDATE` 与 `jsonb_agg` 子查询共存要实测，不能假设。** Postgres 对带子查询的 `SELECT ... FOR UPDATE` 有限制，而且即便语法通过，行锁也只锁 `pr_helper_workflows` 那一行，锁不住 `workflow_stages`。今天真正的互斥来自同一事务里先取的 `pg_advisory_xact_lock`，`FOR UPDATE` 是冗余的第二层——所以这里的正确做法多半是**拆成两条语句**（先 `SELECT version ... FOR UPDATE`，再用 `trackedWorkflowColumns` 取定义），而不是硬拼成一条。
3. **1608 行的 `previous` 今天读在事务外、advisory lock 之前。** 那是既有的竞态，不在本方案范围内。**切读点时不要顺手把它挪进事务**——那是行为改动，会改变 `workflowArchiveTransition` / `serverAutomationActivated` 的观察点，必须单独立项、单独写失败测试。
4. **`hydrateGenerationRules` 只在 `listWorkflows` 调用（1552 行）。** 第二批切完必须保留它，否则 `040` 之后 payload 里只有 `contentHash`、关系表里也只有 hash，提示词内容会整体消失在 UI 上。这是**静默丢配置**，不是报错。
5. **列表读的字节可能变大。** 第二批落地后要按母文档《实测：一次 `/api/inbox` 的出站字节》的同一方法复测一次单次响应体，如果显著变大就要重新权衡（例如列表读保留 payload、只切单行读，停在 A + 部分 B）。
6. **单元测试碰不到数据库。** 每步的守护只有两样：`workflow-rows` 的 `toStrictEqual` 往返恒等测试，加上部署后一次只读差分校验（见第六节）。所以**每步部署后都必须跑一次那条 SQL**，把它当门禁，而不是可选检查。
7. **`archived` 过滤仍可下推。** 第二批切完后，`listWorkflowConfigurationWarnings` 之类不再需要「取全量行 → 解析 → JS 过滤」，`archived` 已是独立列（`handoff.md` 第 124 行记的权衡到此失效）。这是**顺带的机会，不是本方案的义务**，不要塞进同一批。

## 六、前置校验与每步门禁（2026-08-22 已跑，可复用）

`037` 的一致性校验函数 `pr_helper_rebuild_workflow` / `pr_helper_normalize_payload` 在该迁移末尾就被 `DROP FUNCTION` 了，生产里不存在；`AGENTS.md` 禁止 runtime DDL，`prh_readonly` 也调不到 `extensions.digest`。所以校验被改写成一条**纯只读、内联**的 `SELECT`，效果等同。

2026-08-22 的实跑结果（这是本方案最强的前置证据）：

| 指标 | 值 |
| --- | --- |
| 参与比对的流程行 | 35 |
| 关系表重建结果与 payload **不一致**的行 | **0** |
| `workflow_stages` 行数 / payload 内步骤数 | 45 / 45，逐流程零分歧 |
| payload 里仍带内联 `content` 的步骤 | 0（44 个带 `contentHash`） |
| `version` 列为 NULL 的行 / 与 `workflow_versions` 的 `MAX` 不一致的行 | 0 / 0 |

也就是说：**今天把 payload 删掉，关系表能逐字段重建出完全相同的对象。** 顺带纠正一处旧记录——步骤数是 45 不是 44，写「44」时是对的，之后长了一个。

门禁用法：A / B / D 每步部署后各跑一次同一条 SQL，`mismatched` 必须为 0；E 之前最后跑一次。

## 七、放弃条件

任一条成立就停在当前步，不再往下：

- 第二批切完后单次 `/api/inbox` 响应体变大且无法回收 → 停在 A，B 回滚。
- 校验 SQL 出现 `mismatched > 0` → 立即回滚该步代码，先查漂移来源，不得带着不一致往下走。
- 没有明确的「不需要回滚到旧部署」的判断 → 永久停在 D，不做 E。
