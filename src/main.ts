import './style.css';
import { getStageAction, githubCompareUrl, githubPullUrl, type CheckState, type PullState } from './lib/domain';

type Stage = { id: string; source: string; target: string; pr: PullState; number?: number; checks: CheckState; approvals: string; previewApproved: boolean };
const repository = 'acme/payments-service';
const branches = ['feature/20260622', 'dev', 'main', 'hotfix/login'];
const stages: Stage[] = [
  { id: 'feature', source: 'feature/20260622', target: 'dev', pr: 'open', number: 128, checks: 'pending', approvals: '1 / 2', previewApproved: false },
  { id: 'release', source: 'dev', target: 'main', pr: 'none', checks: 'pending', approvals: '—', previewApproved: false },
];
const events = ['PR #128 已创建，正在等待 GitHub Actions。'];

function notify(message: string) {
  events.unshift(message);
  if (Notification.permission === 'granted') new Notification('PR Flow', { body: message });
}

function actionLabel(stage: Stage, index: number) {
  const action = getStageAction({ previous: index ? { pr: stages[index - 1].pr, checks: stages[index - 1].checks } : undefined, stage });
  return ({ 'create-pr': '创建 Draft PR', 'confirm-preview': '确认预览环境', monitor: '正在监控', locked: '等待上一步' })[action];
}

function render() {
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <main>
      <header><div><p class="eyebrow">GITHUB PR ORCHESTRATOR</p><h1>发布流程，不必盯着每个 Tab。</h1><p class="sub">集中追踪多仓库 PR、门禁、Actions 与 Approval；在轮到你决策时才提醒你。</p></div><button id="permission" class="ghost">启用浏览器通知</button></header>
      <section class="summary"><div><span>仓库</span><strong>${repository}</strong></div><div><span>当前流程</span><strong>支付功能上线</strong></div><div><span>下一步</span><strong>${actionLabel(stages[0], 0)}</strong></div></section>
      <section class="grid"><div class="panel workflow"><div class="panel-head"><div><p class="eyebrow">FLOW #20260622</p><h2>feature → dev → main</h2></div><a class="text-link" href="https://github.com/${repository}" target="_blank">打开仓库 ↗</a></div>${stages.map((stage, index) => stageCard(stage, index)).join('')}</div>
      <aside class="side"><div class="panel"><p class="eyebrow">NOTIFICATIONS</p><h2>需要你处理</h2><div class="events">${events.map(event => `<p>${event}</p>`).join('')}</div></div><div class="panel"><p class="eyebrow">NEW FLOW</p><h2>创建 PR 编排</h2><label>Source<select id="source">${branches.map(branch => `<option>${branch}</option>`).join('')}</select></label><label>Target<select id="target">${branches.map(branch => `<option>${branch}</option>`).join('')}</select></label><button id="add-stage" class="primary">添加到流程</button><small>分支来自 GitHub 仓库；接入 GitHub App 后会替换当前演示数据。</small></div></aside></section>
    </main>`;
  document.querySelector('#permission')!.addEventListener('click', async () => { await Notification.requestPermission(); render(); });
  document.querySelector('#add-stage')!.addEventListener('click', () => notify('已保存新的 PR 步骤模板。'));
  stages.forEach((stage, index) => document.querySelector(`#action-${stage.id}`)?.addEventListener('click', () => act(stage, index)));
}

function stageCard(stage: Stage, index: number) {
  const action = getStageAction({ previous: index ? { pr: stages[index - 1].pr, checks: stages[index - 1].checks } : undefined, stage });
  const link = stage.number ? githubPullUrl(repository, stage.number) : githubCompareUrl(repository, stage.source, stage.target);
  return `<article class="stage ${action === 'locked' ? 'locked' : ''}"><div class="step">${index + 1}</div><div class="stage-main"><p class="route"><b>${stage.source}</b><span>→</span><b>${stage.target}</b></p><p class="meta">${stage.number ? `PR #${stage.number} · ${stage.pr}` : '尚未创建 PR'} </p><div class="badges"><span class="${stage.checks}">Actions: ${stage.checks}</span><span>Approval: ${stage.approvals}</span></div></div><div class="stage-actions"><a href="${link}" target="_blank" class="text-link">${stage.number ? 'GitHub PR ↗' : '在 GitHub 中创建 ↗'}</a><button id="action-${stage.id}" class="${action === 'locked' || action === 'monitor' ? 'disabled' : 'primary'}" ${action === 'locked' || action === 'monitor' ? 'disabled' : ''}>${actionLabel(stage, index)}</button></div></article>`;
}

function act(stage: Stage, index: number) {
  const action = getStageAction({ previous: index ? { pr: stages[index - 1].pr, checks: stages[index - 1].checks } : undefined, stage });
  if (action === 'create-pr') { stage.pr = 'open'; stage.number = 129; stage.checks = 'pending'; stage.approvals = '0 / 2'; notify(`${stage.source} → ${stage.target} Draft PR 已创建，正在监控门禁。`); }
  if (action === 'confirm-preview') { stage.previewApproved = true; notify('预览环境已确认，可创建 dev → main PR。'); }
  render();
}

render();
