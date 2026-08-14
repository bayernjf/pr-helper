# 生产库只读排查通道：从零配置指南

> 创建：2026-08-14。
> 目的：让排查生产问题时**不必再让人代跑 SQL**——配一个只读角色，用一个只允许 `SELECT` 的本地脚本直接查 Supabase。
> 适用范围：只读诊断。任何 DDL 与数据修改仍走 `db/` 下有序迁移文件（[`AGENTS.md`](../AGENTS.md) 第 7 条），本文档不为绕过它提供路径。

## 零、先明确三件事

1. **不要试图从 Vercel 读生产 `DATABASE_URL`。** 它被标记为 sensitive 变量，Vercel 的设计是只写不可读，`vercel env pull` 拉下来是空字符串 `DATABASE_URL=""`。这不是配置错误，别在这里浪费时间。
2. **凭据文件放在仓库外。** 全程放 `~/.config/pr-helper/db.env`，权限 600。仓库里出现任何数据库密码都是事故。
3. **用一个新建的只读角色，不要用 `postgres` 超级用户。** 超级用户拿来查询，一次手滑就是生产事故。

### 这份文档不用你一步步照做

下面一到五节的每一步，**都可以直接让 AI 替你做**。把需求说出来就行，例如：

> 「照 `docs/supabase-readonly-debugging.md` 帮我把只读查询通道配好」

AI 能直接完成的：写 `~/.local/bin/prh-sql.mjs`、写 `~/.config/pr-helper/db.env` 并 `chmod 600`、跑连通性验证、之后所有的排查查询。

只有两件事必须**你自己**在 Supabase 控制台的 SQL Editor 里点 Run，因为它们是 DDL 且需要超级用户权限——AI 的只读通道执行不了，也不该能执行：

- 第一节的 `create role prh_readonly ...`
- 第六节的 `alter role prh_readonly bypassrls`

同时你需要提供两样 AI 拿不到的信息：你自己设的角色密码、以及 Supabase 控制台上的 Host 和项目 ref。**密码请贴在对话里而不是让 AI 猜**，贴完注意第十节的轮换纪律。

### 装上 Supabase 官方技能包（推荐）

在仓库根目录执行一次：

```bash
npx skills add supabase/agent-skills
```

装两个技能，AI 会在相关任务上自动加载：

| 技能 | 覆盖什么 |
| --- | --- |
| `supabase` | Supabase 全线产品排查：RLS 意外、permission denied、schema cache、超时、Auth/JWT/session、Edge Functions、Realtime、Storage、日志查询 |
| `supabase-postgres-best-practices` | Postgres 本体：索引与查询优化、EXPLAIN 分析、连接池与预处理语句、锁与死锁、schema 与迁移、RLS 性能 |

装完的落点：真实文件在 `.agents/skills/`，`.claude/skills/` 和 `.trae/skills/` 是指向它的符号链接，版本由 `skills-lock.json` 按内容哈希锁定。这几处都已入库，clone 下来就带着，无需每人重装。

为什么值得装：本文档第六节那个"查得通但什么都查不到"的 RLS 陷阱，正是 `supabase` 技能里明确列出的坑之一。技能包能让 AI 少走一轮弯路，也会提醒 Supabase 的 API 与配置项版本变动频繁、不要凭记忆作答。

---

## 一、在 Supabase 建只读角色

打开 Supabase 控制台 → 左侧 **SQL Editor** → **New query**，粘贴下面这段，把 `换成你自己的强密码` 真的换掉（自己想一个，别用示例；也不是你建项目时填的那个数据库密码——那是 `postgres` 用户的密码，这里是**新建一个角色**）：

```sql
create role prh_readonly login password '换成你自己的强密码';
grant usage on schema public to prh_readonly;
grant select on all tables in schema public to prh_readonly;
alter default privileges in schema public grant select on tables to prh_readonly;
```

点 **Run**。看到 `Success. No rows returned` 就对了。

第三行是"已存在的表"，第四行是"以后新建的表"，两行都要，否则下次迁移加了新表你又查不到。

### 密码里避开这些字符

`/` `+` `:` `@` 会让连接串解析出问题（下面第四步的脚本已经绕过了，但纯字母数字更省事）。建议直接用字母数字混合的 32 位。

---

## 二、拿到连接信息

Supabase 控制台 → 右上角 **Connect**（或项目 Settings → Database）→ 找 **Connection pooling** 那一栏，你需要抄下四样东西：

| 项 | 长什么样 | 说明 |
| --- | --- | --- |
| Host | `aws-1-ap-south-1.pooler.supabase.com` | 这一串里的 `ap-south-1` 就是"区域"，是**你项目所在的机房**，页面上直接写好了，照抄，不用自己猜 |
| Port | `6543` | pooler 端口。**不要用 5432** |
| Database | `postgres` | 固定 |
| User | `prh_readonly.abcdefghijklmnop` | 注意格式：**角色名 + 英文句点 + 项目 ref** |

最后一项是新手最容易卡住的地方。走 pooler 连接时，用户名必须写成 `角色名.项目ref`，pooler 靠这个点号后面的部分判断要把连接转发到哪个项目。项目 ref 是那串 20 位小写字母，在项目 URL 里也能看到：`https://supabase.com/dashboard/project/<项目ref>`。

所以最终连接串形如：

```
postgresql://prh_readonly.<项目ref>@aws-1-<区域>.pooler.supabase.com:6543/postgres
```

---

## 三、把凭据写到仓库外

在终端里执行（**把 `<...>` 三处都换成你真实的值**，密码用第一步你自己设的那个）：

```bash
mkdir -p ~/.config/pr-helper
```

然后用编辑器建文件——这一步建议**不要用 `printf` 一行搞定**，因为密码里的特殊字符会被 shell 吃掉，而且命令会留在 shell 历史里。用 VS Code：

```bash
code ~/.config/pr-helper/db.env
```

文件内容就一行，末尾要有换行：

```
DATABASE_URL=postgresql://prh_readonly.<项目ref>:<你的密码>@aws-1-<区域>.pooler.supabase.com:6543/postgres
```

### 保存后找不到文件？

`~` 是你的用户主目录（`/Users/你的用户名`），`.config` 以点开头，在 Finder 里默认是隐藏的。按 `Cmd + Shift + .` 可以切换显示隐藏文件。命令行确认更直接：

```bash
ls -l ~/.config/pr-helper/db.env
```

确认存在后立刻收紧权限：

```bash
chmod 600 ~/.config/pr-helper/db.env
```

---

## 四、装一个只允许 SELECT 的查询脚本

放 `~/.local/bin/prh-sql.mjs`，同样在仓库外：

```bash
mkdir -p ~/.local/bin && code ~/.local/bin/prh-sql.mjs
```

内容如下。把 `import postgres from` 后面那个绝对路径换成你本机 pr-helper 仓库的实际路径（直接借用仓库已装好的 `postgres` 依赖，省得再全局装一份）：

```js
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import postgres from '/你的路径/pr-helper/node_modules/postgres/src/index.js';
const raw = readFileSync(homedir() + '/.config/pr-helper/db.env', 'utf8');
const url = (raw.match(/^DATABASE_URL=(.*)$/m) || [])[1]?.trim();
if (!url) { console.error('no DATABASE_URL'); process.exit(1); }
// The role password may contain / + : which URL parsing mangles, so credentials are split by hand.
const body = url.replace(/^postgres(ql)?:\/\//, '');
const at = body.lastIndexOf('@');
const [user, ...passParts] = body.slice(0, at).split(':');
const [hostPort, database] = body.slice(at + 1).split('/');
const [host, port] = hostPort.split(':');
const sql = postgres({ host, port: Number(port) || 5432, database: database || 'postgres', username: user, password: passParts.join(':'), max: 1, prepare: false, ssl: 'require', idle_timeout: 5, connect_timeout: 15 });
const text = process.argv[2];
if (!/^\s*select\b/i.test(text)) { console.error('read-only runner: only SELECT allowed'); process.exit(1); }
try { console.log(JSON.stringify(await sql.unsafe(text), null, 1)); }
finally { await sql.end(); }
```

三个设计点，都不是可选的：

- **手工拆连接串**，不用 `new URL()`。密码里一个 `/` 就会让 URL 解析抛 `ERR_INVALID_URL`，而那个报错**会把完整连接串连密码一起打印到终端**。
- **`prepare: false`**。Supabase 的事务模式 pooler 不支持预处理语句。
- **正则挡住非 SELECT**。这是护栏，不是装饰：只读角色是第一道防线，脚本是第二道。

---

## 五、验证

```bash
cd ~ && node ~/.local/bin/prh-sql.mjs "select current_user, now()"
```

看到 `current_user: "prh_readonly"` 就通了。

先在 `~` 下跑，是为了确认脚本不依赖当前目录。之后在哪跑都可以。

---

## 六、最大的坑：查得通，但什么都查不到

**现象**：连接成功，语法没错，`select count(*) from pr_helper_workflows` 返回 `0`。你会以为是数据不存在——不是。

**原因**：这些表开了行级安全（RLS）且**没有任何 policy**。RLS 的行为是"默认拒绝"，非表所有者会拿到**空结果集，且不报错**。这个静默失败极具误导性。

先确诊，别猜：

```sql
select relname, relrowsecurity, relforcerowsecurity from pg_class where relname like 'pr_helper%' or relname like 'workflow%';
```

```sql
select tablename, policyname from pg_policies where schemaname = 'public';
```

如果第一条查询 `relrowsecurity = true`，而第二条一行都没有，那就确诊了：只有表所有者（`postgres`，它有 `rolbypassrls`）能读。

**解法**——在 Supabase SQL Editor 里执行：

```sql
alter role prh_readonly bypassrls;
```

一行搞定，让这个只读角色跳过 RLS。之后重跑第五步的查询，数据就出来了。

### 关于这个授权，你需要知道的

- `bypassrls` 让这个角色能读**所有**行，包括 `pr_helper_ai_automation_credentials` 里的密文字段。它是一把万能读钥匙，所以它的密码必须像密钥一样对待。
- 另一条路是给每张表补 `create policy ... for select using (true)`。但那是在生产库上执行 DDL，绕开了 `db/` 下的有序迁移，违反 [`AGENTS.md`](../AGENTS.md) 第 7 条。`alter role` 只改角色属性、不动 schema，是这两者里正确的那个。
- 这个角色和它的 `bypassrls` 属性不在任何迁移文件里，属于**运维配置而非 schema**。它的来历就记在本文档。

---

## 七、常见报错对照表

| 报错 | 真正的原因 | 怎么办 |
| --- | --- | --- |
| `TypeError: Invalid URL` / `ERR_INVALID_URL` | 密码含 `/` `+` `:` 等字符，URL 解析失败 | 用第四步的手工拆分脚本。**并且**：这个报错已经把密码打到终端了，排查结束后轮换密码 |
| 查询成功但结果全空、count 为 0 | RLS 默认拒绝，不是没数据 | 见第六节 |
| `relation "xxx" does not exist` | 表名猜错了 | 用第八节的清单，或先查 `information_schema.tables` |
| `column "xxx" does not exist` | 列名猜错了 | 先查 `information_schema.columns`，见第八节第一条 |
| `prepared statement ... already exists` | 忘了 `prepare: false` | 见第四步 |
| 连接超时 | 用了 5432 而非 pooler 的 6543；或用户名漏了 `.项目ref` | 见第二节 |
| `DATABASE_URL=""`（来自 `vercel env pull`） | sensitive 变量只写不可读 | 别走这条路，见第零节 |

---

## 八、表名列名速查

**先查结构，再写查询**——省下大量猜错列名的往返：

```bash
cd ~ && node ~/.local/bin/prh-sql.mjs "select table_name, string_agg(column_name, ', ' order by ordinal_position) as cols from information_schema.columns where table_schema='public' group by table_name order by table_name"
```

两个反直觉的地方，值得单独记住：

- **表名前缀不统一。** `pr_helper_users` / `pr_helper_workflows` / `pr_helper_ai_automation_credentials` 有前缀；`workflow_stage_states` / `workflow_automation_actions` / `workflow_automation_runs` / `workflow_stage_deployments` / `reconciliation_runs` **没有**。写 `pr_helper_workflow_stage_states` 一定报表不存在。
- **`github_installation_id` 在 `pr_helper_users` 上，不在 `pr_helper_workflows` 上。** 服务端代码里的 `row.github_installation_id` 是 join 出来的（[`api/_lib/workflows-store.ts:1196`](../api/_lib/workflows-store.ts:1196)）。
- `workflow_stage_states` 有 `ahead_by`，**没有** `behind_by`，也没有 `locked`——锁定是 `stageIsUnlocked()` 从前序步骤状态算出来的，不是存的字段。
- 工作流的步骤和自动化策略全在 `pr_helper_workflows.payload` 这个 JSONB 里。展开步骤：

```sql
select w.payload->>'repository' as repo, s.ord-1 as stage_index,
       s.stage->>'source' as source, s.stage->>'target' as target,
       s.stage->'automation'->>'executionMode' as mode,
       s.stage->'automation'->>'autoCreatePullRequest' as auto_create,
       s.stage->'automation'->>'triggerMinCommits' as min_commits,
       length(coalesce(s.stage->'automation'->'generationRule'->>'content','')) as rule_len
from pr_helper_workflows w, jsonb_array_elements(w.payload->'stages') with ordinality as s(stage, ord)
order by repo, stage_index
```

- BIGSERIAL 主键经 postgres.js 回来是**字符串**，不是数字。比较 id 时注意。

---

## 九、排查自动化不触发时的标准查询顺序

按这个顺序走，四步之内能定位到具体那一道门禁：

1. **策略是否真的开了**（用第八节的 JSONB 展开查询）。要看到 `mode=server`、`auto_create=true`、`rule_len > 0`。
2. **凭据是否齐备**：

```sql
select user_id, auto_generate_pr_message, auto_confirm_pr_creation, key_hint from pr_helper_ai_automation_credentials
```

3. **步骤状态**——这里通常就是答案：

```sql
select stage_index, source, target, pull_number, pull_state, checks_state,
       checks_passed, checks_total, ahead_by, head_sha, updated_at
from workflow_stage_states where repository = '<owner>/<repo>' order by stage_index
```

关键点：`canCreateNext` 要求前一步 `pull_state='merged'` **且** `checks_state='success'`。一个 `checks_passed = checks_total` 却 `checks_state='pending'` 的步骤，说明是**部署门禁**把它拉下来的（`mergeChecksWithDeployments` 会把 success 降级成 pending），下一步查部署。

4. **部署门禁**：

```sql
select d.stage_index, d.source, d.provider, d.run_name, d.state
from workflow_stage_deployments d join pr_helper_workflows w on w.id = d.workflow_id
where w.payload->>'repository' = '<owner>/<repo>'
```

把这里的行数和 `payload->'deployments'` 里配置的条数**对比**。少一条，就说明有一个部署目标的 `workflowName` 在仓库里匹配不到同名工作流（精确字符串比较），它会永久停在 `pending`，把整条链锁死。用 `gh api repos/<owner>/<repo>/actions/workflows --jq '.workflows[].name'` 核对真实工作流名。

5. **动作队列**：

```sql
select a.id, a.kind, a.state, a.attempts, a.idempotency_key, a.failure_reason, a.created_at, a.updated_at, r.stage_index
from workflow_automation_actions a join workflow_automation_runs r on r.id = a.run_id
order by a.id desc limit 20
```

`attempts=0` 且 `failure_reason=null` 的 `queued` 行 = 入队成功但**从未被领取**。幂等键里包含 head sha，分支一动这行就再也不会被重算到，成为孤儿。

---

## 十、收尾纪律

排查结束后必须做的事：

1. **删掉所有临时导出**。`/tmp` 下的 env 文件、日志 dump，只要碰过生产凭据或生产数据就删。
2. **密码泄漏就轮换**，不要拖：

```sql
alter role prh_readonly password '新的强密码';
```

然后同步更新 `~/.config/pr-helper/db.env`。触发轮换的典型情形：`ERR_INVALID_URL` 之类的报错把连接串打进了终端记录或聊天记录。

3. **永远不要**把 `db.env` 的内容、连接串、或角色密码写进仓库任何文件、commit message 或 PR 描述。
