# 交接：拆分 `src/main.ts` — 执行手册（2026-11-12）

> 交给下一个会话直接开干。**当前代码一行未动**，只存在两份文档：本文件与 [`2026-11-12-split-main-ts.md`](2026-11-12-split-main-ts.md)（总方案）。

## 0. 任务

把 `src/main.ts` 从 2 968 行拆成 `app/` 下多个模块，最终 `main.ts` 只剩 `init()` / `render()` / `goTo()` 与事件编排（约 200–300 行）。这是 `docs/current-state.md` 里代码质量 7.5/10 的主要扣分项。

## 1. 仓库与分支现状

- 仓库：`/Users/jiangfeng/000mycodes/pr-helper`，远端 `git@github.com:bayernjf/pr-helper.git`。
- 分支：`dev` 是工作分支（当前 `95c9414e`，领先 `origin/dev` **2 个提交，都是纯文档**）；`main` 是生产（`fc50d7e5`）。
- 纪律：本地 commit 即可；**push 前先问用户**。已知行为：push `dev` 只跑 CI 不部署（`dev` 历史上从未产生 deploy run），但曾观察到 push 时 main 部署被 GitHub 重投递一次（部署内容是同一份生产代码，不会把 dev 带上生产）。
- 分支长期只留 `main` / `dev`，Conventional Commits。

## 2. 硬事实（全部实测）

| 指标 | 值 | 怎么验的 |
| --- | --- | --- |
| `src/main.ts` 行数 | 2 968 | `wc -l` |
| 顶层声明 | 221 | `grep -cE "^(export )?(async )?function \|^const "` |
| 顶层可变状态 `let` | **67** | `grep -cE "^let "` |
| `export` | **0** | 纯入口，无对外契约 |
| `src/main.ts` 单测 | **无** | 没有任何 `*.test.ts` 引用它 |
| 单元测试 | 44 文件 / **857** 用例 | `npm test` |
| 浏览器 E2E | **34** 用例（CI 内 14.8s，本地 37.3s） | `npx playwright test --list` / `npm run test:e2e` |
| `src/app/` 现有模块 | 9 个，共 365 行 | `dom`、`ui/theme`、`ui/toast`、`ui/audit`、`ui/format`、`ui/lane-sorting`、`ui/confirm`、`ui/tooltip`、`types` |
| CI 步骤 | 迁移门禁 → tsc → 单测 → build → e2e | `ci.yml` 第 4–10 步，最近 run `43242043381` 全绿 |

## 3. 不可违背的顺序原则

**先收状态，再搬函数。**

原因：几乎每个函数都直接读写 `workflows`、`active`、`actionQueue`、`statuses` 等模块级 `let`。如果先把函数搬进新文件、让新文件 `import { workflows } from '../main'`，就会形成 `main.ts ↔ 新模块` 的双向依赖。ESM 下这**不会编译报错**，只在运行时给出 `undefined`（初始化时序陷阱）。`tsc` 抓不到，只有 34 个 e2e 能抓到。

所以：`app/state/*.ts` 导出**可变对象**（如 `export const session = { token: '', repos: [], ... }`），`main.ts` 改成 `session.xxx` 访问；等 `grep -c "^let " src/main.ts` 归零/接近归零，才动阶段 2。

`export let` 也不行——导入方不能给 imported binding 赋值（`token = x` 会 TypeError）。必须是对象字段或显式 setter。

## 4. 阶段与批次

### 阶段 1：状态搬进 `app/state/`（前置，不可跳过）

| 批 | 变量 | 目标模块 | 引用数（实测） |
| --- | --- | --- | --- |
| **1-A** | `token`、`repos`、`branches`、`repositoryActionWorkflows`、`repositoryEnvironments`、`repositoryActionsLoaded`、`repositoryEnvironmentsLoaded`、`githubInstallationSettingsUrl`、`githubLogin` | `app/state/session.ts` | 38 / 38 / 24 / 9 / 10 / 8 / 5 / 11 / 15 |
| **1-B** | `workflows`、`active`、`workflowMutationRevision`、`cloudWorkflowStorage`、`pendingLocalWorkflowSync`、`cloudWorkflowSyncError`、`cloudWorkspaceLoading` | `app/state/workflows.ts` | 未统计，动手前先数 |
| **1-C** | `actionQueue`、`workflowStageStates`、`workflowStageEvents`、`workflowStageDeployments`、`workflowStageDeploymentRuns`、`workflowConfigurationWarnings`、`syncHealth`、`workflowRuns`、`timeline`、`preflightResults/Loading/Error`、`recoveryStatuses`、`automationActions`、`actionQueueError/Refreshing/ReconciliationScheduled`、`actionQueueRequestQueue` | `app/state/projection.ts` | 最大簇（18 个），但名字都很独特、误伤率低 |
| **1-D** | `editorDraft`、`deploymentFormOpen/AdvancedOpen/Highlight/EditIndex/Draft`、`stageRouteEditIndex`、`stepFormOpen`、`returnHighlight`、`screen`、`statuses`、`refreshOnNextDetail`、`overviewSnapshotRefreshed/Refreshing`、`detailStatusRefreshing`、`lastDetailLiveRead`、3 个 `*Bound` 标志 | `app/state/ui.ts` | 未统计 |
| **1-E** | `overviewFilter`、`laneSearchQuery`、`expandedLaneIds`、`laneSortMode`、`laneSortDirection`、`pushSubscribed`、`pushConfigured`、`repositoryManagementWindow/Timer`、`mergingStages`、`recentlyCreatedPullNumbers`、`recentlyMergedPullNumbers`、`resolvedAutomation`、`aiConfig`、`automationCredentialConfigured` | `app/state/filters.ts` + `app/state/ai.ts` | 未统计 |

建议每批内部再分 2–3 小步（先搬名字独特的，再搬 `token`/`repos`/`branches` 这类大众词），每小步都跑全量验收。**1-C 可以先做**——变量多但名字长且独特，误伤率最低，适合用来把整条流程跑通。

阶段 1 完成判据：`grep -cE "^let " src/main.ts` 为 0（或只剩确有必要的局部）。

### 阶段 2：抽无状态纯函数（低风险）

`deploymentKey`、`options`、`value`、`dynamicBranchStatusText`、`stageStaleBadge`、`syncHealthBanner`、`lockedStageText`、`nextActionTitle`、`automationStepKey` → `app/ui/format.ts`（已有）或新建 `app/ui/derive.ts`。约 10 个函数。

### 阶段 3：抽渲染层（重 DOM，靠 e2e 兜）

| 目标 | 内容 | 近似行区间（`grep` 顶层声明推得，动手前按依赖复核） |
| --- | --- | --- |
| `app/render/overview.ts` | `overview()`、`laneSortControls()`、`bindFailureCenter()`、滚动控件绑定 | ~385–1460 |
| `app/render/lane.ts` | `projectLane()`、`laneRunSummary()`、`laneConfigurationWarnings()`、两个 `*TimelineSection()` | ~1074–1530 |
| `app/render/detail.ts` | `detail()`、`stageTimeline()`、`flowProgressBar()`、`stageProgressStatus/Tooltip()`、`projectedDetailStatuses()` | ~1155–2215 |
| `app/render/editor.ts` | `editor()`、`renderStepForm()`、`renderStageRouteForm()`、`renderDeploymentSettings/Form()`、`renderRecoveryPolicySettings()`、`renderDraft()`、`bindDraftStepSorting()` | ~1630–1980 |

### 阶段 4：抽对话框与操作（最后做）

`dialogs/create-pr.ts`（`showCreateDialog`、`confirmAiGenerationOverwrite`）、`dialogs/merge.ts`、`dialogs/takeover.ts`、`dialogs/generation-rules.ts`、`dialogs/steps.ts`、`dialogs/account.ts`、`dialogs/cloud-sync.ts`、`actions/maintenance.ts`（重试/Codex 修复/回滚）、`status-refresh.ts`。

## 5. 已探明的误伤点（1-A 必读，动手前先处理）

机械替换 `\b变量名\b` 会在这几处出事，**逐条确认过**：

| 变量 | 位置 | 情况 | 处理 |
| --- | --- | --- | --- |
| `token` | `main.ts:791` | HTML 字符串里的 `id="token"` | 不能替换 |
| `token` | `main.ts:796` | DOM 选择器 `'#token'` | 不能替换 |
| `branches` | `main.ts:2382` | `const branches = await githubFetch<...>(...)` 是**局部变量** | 替换会变成 `const session.branches = ...` → 语法错误 |
| `githubLogin` | `main.ts:554`、`561` | `const githubLogin = ...` 是**局部变量** | 同上 |
| `githubLogin` | `main.ts:543` 等 | `member.githubLogin` 是**对象属性**（属性名不能改） | 用负向后视 `(?<!\.)\bgithublogin\b`，或手工跳过 |
| `repos` | — | 38 处**尚未逐处核实** | 动手前先 `grep -nE "\brepos\b"` 全看一遍 |

另有一个 1-B 阶段的陷阱（提前记下）：`main.ts:1944` 有 `const workflows = repositoryActionWorkflows.map(...)`，**局部 `workflows` 遮蔽了全局 `workflows`**。搬 `workflows` 时如果无脑替换会改坏这一行。

**推荐做法**：先把要替换的变量名整体 `grep -nE "\bNAME\b"` 打印出来逐行确认，再决定用 `perl -i -pe` 批量还是逐处 `Edit`。批量替换后必须 `git diff` 人工扫一遍字符串有没有被改。

## 6. 每批验收（四条全绿才提交）

```bash
npm run check:migrations
npm run lint        # tsc --noEmit
npm test            # 857 用例
npm run test:e2e    # 34 用例 —— 拆分唯一可靠的回归网
```

任一红都不进入下一批。提交信息说明搬了哪些状态、为什么。

## 7. 禁止事项

- **不动 `src/lib/`**：`domain.ts`、`workflow.ts`、`workflow-run.ts` 是 `AGENTS.md` 第 1 条指定的真相来源。本次只搬 UI 与编排层，不改门禁判定逻辑。
- **不顺手改行为**：只做搬家 + 改导入。任何"顺便修一下"都会让 e2e 失败时无法区分是搬家错还是逻辑错。
- **不改 DOM 选择器字符串**：e2e 依赖 `document.querySelector` 里的字符串。
- **不让新模块反向 import `main.ts`**（见第 3 节）。
- **不先给 `main.ts` 补单测**：在 2 968 行单体上补很贵；用 34 个 e2e 兜住，搬完再按模块补。
- **不一次搬完**：每批独立提交，可单独回滚。
- **不碰 `node_modules/`、`dist/`**（`AGENTS.md` 第 10 条）。

## 8. 关键文件

| 文件 | 用途 |
| --- | --- |
| `src/main.ts` | 拆分对象 |
| `src/app/` | 现有 9 个小模块，导入方向 `main.ts → app/*` 单向 |
| `docs/superpowers/plans/2026-11-12-split-main-ts.md` | 总方案（批次表更详细） |
| `.github/workflows/ci.yml` | 门禁步骤 |
| `AGENTS.md` | 项目规则（第 1、7、10 条与本次强相关） |
| `docs/current-state.md` | 当前架构与边界事实来源 |

## 9. 卡住时的判断依据

- `tsc` 只能抓类型错误，**抓不到 ESM 循环依赖的时序问题**——不要用它判断拆分是否安全。
- 唯一可靠的信号是 34 个 e2e 全绿；它覆盖真实 DOM、二次确认、手机竖屏、创建/合并 PR、进度条、失败接管弹窗。
- 如果出现"页面白屏 / 某个功能莫名 undefined"，第一嫌疑是循环依赖，第二嫌疑是某个 `let` 被搬走后还有人按旧名访问。
