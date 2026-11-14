# 拆分 `src/main.ts`（2026-11-12 方案）

> 状态：**已完成（2026-11-13，`dev` `96bd94fe`）**。实测结果：`src/main.ts` 2 968 → **1 794** 行、顶层可变 `let` 67 → **0**，拆入 `src/app/{state,render,dialogs,ui}` 新增 23 个模块（该目录现共 32 个文件）；每批 `tsc` / 44 文件 857 单测 / 34 e2e 全绿。执行过程中与本方案的实际偏差见 [`2026-11-12-split-main-ts-handoff.md`](2026-11-12-split-main-ts-handoff.md)。

## 1. 现状实测

| 指标 | 值 | 来源 |
| --- | --- | --- |
| 文件行数 | 2 968 | `wc -l src/main.ts` |
| 顶层声明 | 221 | `grep -cE "^(export )?(async )?function \|^const "` |
| 顶层可变状态 `let` | **67** | `grep -cE "^let "` |
| `export` | **0** | 纯入口，无对外契约 |
| 单测覆盖 | **无** | 无任何 `*.test.ts` 引用 `src/main.ts` |
| 回归网 | 34 个 e2e（CI 内 14.8s）+ 857 单测 | `ci.yml` 第 7/10 步 |

`src/app/` 已存在 9 个小模块（共 365 行：`dom`、`ui/theme`、`ui/toast`、`ui/audit`、`ui/format`、`ui/lane-sorting`、`ui/confirm`、`ui/tooltip`、`types`）。方向是 `main.ts → app/*` 单向导入，拆分必须延续这个方向，否则会形成循环引用。

## 2. 真正的障碍不是行数，是 67 个全局 `let`

几乎每个函数都直接读写这些模块级变量（`workflows`、`active`、`actionQueue`、`statuses`……）。如果先把函数搬到新文件、让新文件 `import { workflows } from '../main'`，就会与 `main.ts` 形成双向依赖，ESM 下表现为初始化时序陷阱（运行时 `undefined`），而不是编译错误。

所以顺序必须是**先收状态、再搬函数**，不能反过来。

## 3. 阶段划分

### 阶段 1（前置，不可跳过）：状态收进 `app/state/`

把 67 个 `let` 按归属迁进 5 个状态模块，`main.ts` 改为 `state.xxx` 访问。行为完全不变，只改访问路径。分 5 批，每批一次提交 + 全量验证。

| 批 | 状态簇 | 变量 | 目标模块 |
| --- | --- | --- | --- |
| 1-A | 认证与仓库 | `token`、`repos`、`branches`、`repositoryActionWorkflows`、`repositoryEnvironments`、`repositoryActionsLoaded`、`repositoryEnvironmentsLoaded`、`githubInstallationSettingsUrl`、`githubLogin` | `app/state/session.ts` |
| 1-B | 工作流与保存 | `workflows`、`active`、`workflowMutationRevision`、`cloudWorkflowStorage`、`pendingLocalWorkflowSync`、`cloudWorkflowSyncError`、`cloudWorkspaceLoading` | `app/state/workflows.ts` |
| 1-C | 服务端投影（最大簇，18 个） | `actionQueue`、`workflowStageStates`、`workflowStageEvents`、`workflowStageDeployments`、`workflowStageDeploymentRuns`、`workflowConfigurationWarnings`、`syncHealth`、`workflowRuns`、`timeline`、`preflightResults/Loading/Error`、`recoveryStatuses`、`automationActions`、`actionQueueError/Refreshing/ReconciliationScheduled`、`actionQueueRequestQueue` | `app/state/projection.ts` |
| 1-D | UI 交互态 | `editorDraft`、`deploymentFormOpen`、`deploymentAdvancedOpen`、`deploymentHighlight`、`deploymentEditIndex`、`deploymentDraft`、`stageRouteEditIndex`、`stepFormOpen`、`returnHighlight`、`screen`、`statuses`、`refreshOnNextDetail`、`overviewSnapshotRefreshed/Refreshing`、`detailStatusRefreshing`、`lastDetailLiveRead`、3 个 `*Bound` 标志 | `app/state/ui.ts` |
| 1-E | 筛选/推送/AI | `overviewFilter`、`laneSearchQuery`、`expandedLaneIds`、`laneSortMode`、`laneSortDirection`、`pushSubscribed`、`pushConfigured`、`repositoryManagementWindow/Timer`、`mergingStages`、`recentlyCreatedPullNumbers`、`recentlyMergedPullNumbers`、`resolvedAutomation`、`aiConfig`、`automationCredentialConfigured` | `app/state/filters.ts` + `app/state/ai.ts` |

阶段 1 完成判据：`grep -cE "^let " src/main.ts` 为 0（或只剩确有必要的局部）。

### 阶段 2：抽无状态纯函数（低风险）

`deploymentKey`、`options`、`value`、`dynamicBranchStatusText`、`stageStaleBadge`、`syncHealthBanner`、`lockedStageText`、`nextActionTitle`、`automationStepKey` 等不读写全局的函数，迁 `app/ui/format.ts`（已有）或新建 `app/ui/derive.ts`。约 10 个函数，可独立提交。

### 阶段 3：抽渲染层（重 DOM，靠 e2e 兜）

| 目标模块 | 迁入内容 | 源行区间 |
| --- | --- | --- |
| `app/render/overview.ts` | `overview()`、`laneSortControls()`、`bindFailureCenter()`、`updateOverviewScrollControls()`、`bindOverviewScrollControls()` | ~385–1460 |
| `app/render/lane.ts` | `projectLane()`、`laneRunSummary()`、`laneConfigurationWarnings()`、`workflowTimelineSection()`、`stepTimelineSection()` | ~1074–1530 |
| `app/render/detail.ts` | `detail()`、`stageTimeline()`、`flowProgressBar()`、`stageProgressStatus/Tooltip()`、`projectedDetailStatuses()` | ~1155–2215 |
| `app/render/editor.ts` | `editor()`、`renderStepForm()`、`renderStageRouteForm()`、`renderDeploymentSettings/Form()`、`renderRecoveryPolicySettings()`、`renderDraft()`、`bindDraftStepSorting()` | ~1630–1980 |

### 阶段 4：抽对话框与操作（最后做）

| 目标模块 | 迁入内容 |
| --- | --- |
| `app/dialogs/create-pr.ts` | `showCreateDialog()`、`confirmAiGenerationOverwrite()`（~2711–2968） |
| `app/dialogs/merge.ts` | `showMergeDialog()`、`canMergePull()`、`laneMergeStatus()`（~2302–2370） |
| `app/dialogs/takeover.ts` | `showTakeoverDialog()`（~2655–2711） |
| `app/dialogs/generation-rules.ts` | `showGenerationRules()`（~2511–2655） |
| `app/dialogs/steps.ts` | `showProjectStepDrawer()`（~1533–1630） |
| `app/dialogs/account.ts` | `showDisconnectDialog()`、`showDeleteAccountDialog()`、`showPermissionsDialog()`、`showTeamsDialog()` |
| `app/dialogs/cloud-sync.ts` | `showCloudSyncDialog()`、`cloudSyncPush/Pull()`、`showCloudSyncRotationDialog()` |
| `app/actions/maintenance.ts` | `retryFailedActions()`、`retryDeployment()`、`showCodexRepairDialog()`、`showDeploymentRollbackDialog()` |
| `app/status-refresh.ts` | `refreshStatuses()`、`loadDetailStatuses()`、`readBranchProtection()`、`resolveDetailSource()` |

### 阶段 5：收尾

`main.ts` 只剩 `init()`、`render()`、`goTo()` 与事件编排，预期约 200–300 行。

## 4. 每阶段验收（缺一不可）

```bash
npm run check:migrations   # 本次不涉及迁移，仍跑一遍确认没误伤
npm run lint               # tsc --noEmit
npm test                   # 857 用例
npm run test:e2e           # 34 用例，拆分唯一可靠的回归网
```

四条全绿才提交；任一红都不进入下一批。

## 5. 风险与刻意不做的事

- **不动 `src/lib/`**：`domain.ts`、`workflow.ts`、`workflow-run.ts` 是 AGENTS.md 第 1 条指定的真相来源，本次只搬 `main.ts` 的 UI 与编排层，不改判定逻辑。
- **不顺手改行为**：拆分 PR 只做搬家 + 改导入。任何"顺便修一下"都会让 e2e 失败时无法区分是搬家错还是逻辑错。
- **不给 `main.ts` 补单测**：搬家过程中最有效的网是 34 个 e2e（真实 DOM + 二次确认 + 手机竖屏）。搬家完成后再按模块补单测，比在 2 968 行的单体上补便宜得多。
- **不一次搬完**：阶段 1 的 5 批 + 阶段 2/3/4 各自独立提交，任一批可单独回滚。
- **DOM 选择器保持不变**：`document.querySelector` 的字符串不要动，e2e 依赖它们。

## 6. 预期收益

- `main.ts` 从 2 968 行降到约 200–300 行，代码质量评分扣分项（7.5/10 的主因）消除。
- 新功能（自动化进度条写入路径、run 级详情）可以在对应模块内增量实现，不必再进单体。
- 每批都有 34 个 e2e 兜底，重构风险可控。
