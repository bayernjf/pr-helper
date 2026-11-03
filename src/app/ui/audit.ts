import { githubAppApiUrl } from '../../lib/github';
import { getLocale, t } from '../../lib/i18n';
import { escape } from '../dom';
import type { OperationAuditEntry } from '../types';

export function auditActionLabel(action: string) { return t(`audit.action.${action}`); }
export function auditTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}
export function csvValue(value: unknown) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
export function downloadAuditCsv(entries: readonly OperationAuditEntry[]) {
  const header = ['id', 'occurred_at', 'action', 'outcome', 'repository', 'workflow_id', 'stage_id', 'source', 'target', 'pull_number', 'run_id', 'failure_reason'];
  const rows = entries.map(entry => [entry.id, entry.occurredAt, entry.action, entry.outcome, entry.repository, entry.workflowId, entry.stageId, entry.source, entry.target, entry.pullNumber, entry.runId, entry.failureReason]);
  const blob = new Blob([[header, ...rows].map(row => row.map(csvValue).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `pr-helper-operation-audit-${new Date().toISOString().slice(0, 10)}.csv` });
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
export function showOperationAuditDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog operation-audit-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('audit.eyebrow')}</p><h2>${t('audit.title')}</h2><p class="meta">${t('audit.desc')}</p><div id="operation-audit-content" class="operation-audit-content"><p class="meta">${t('audit.loading')}</p></div><div class="dialog-actions"><button id="operation-audit-export" type="button" class="ghost" disabled>${t('audit.export')}</button><button value="cancel" class="ghost">${t('audit.close')}</button></div></form>`;
  document.body.append(dialog);
  dialog.showModal();
  const content = dialog.querySelector<HTMLElement>('#operation-audit-content')!;
  const exportButton = dialog.querySelector<HTMLButtonElement>('#operation-audit-export')!;
  void (async () => {
    try {
      const response = await fetch(githubAppApiUrl('/api/inbox?resource=operation-audit&limit=200'));
      const payload = await response.json().catch(() => ({})) as { entries?: OperationAuditEntry[]; message?: string };
      if (!response.ok) throw new Error(payload.message || t('audit.error'));
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      if (!entries.length) { content.innerHTML = `<p class="meta">${t('audit.empty')}</p>`; return; }
      content.innerHTML = `<ol class="operation-audit-list">${entries.map(entry => `<li class="${escape(entry.outcome)}"><div><b>${escape(auditActionLabel(entry.action))}</b><small>${escape(entry.repository || t('audit.unknown'))}${entry.source && entry.target ? ` · ${escape(entry.source)} → ${escape(entry.target)}` : ''}${entry.pullNumber ? ` · PR #${entry.pullNumber}` : ''}${entry.runId ? ` · #${entry.runId}` : ''}</small>${entry.failureReason ? `<p class="error">${escape(entry.failureReason)}</p>` : ''}</div><span><b>${escape(t(`audit.outcome.${entry.outcome}`))}</b><time>${escape(auditTimestamp(entry.occurredAt))}</time></span></li>`).join('')}</ol>`;
      exportButton.disabled = false;
      exportButton.addEventListener('click', () => downloadAuditCsv(entries), { once: true });
    } catch (error) {
      content.innerHTML = `<p class="error">${escape(error instanceof Error ? error.message : t('audit.error'))}</p>`;
    }
  })();
  dialog.addEventListener('close', () => dialog.remove());
}
