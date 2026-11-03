import { t } from '../../lib/i18n';

export function showToast(message: string, undo?: { label: string; onUndo: () => void }) {
  const previous = document.querySelector<HTMLElement>('.toast');
  previous?.hidePopover?.();
  previous?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('popover', 'manual');
  const content = document.createElement('span');
  content.className = 'toast-message';
  content.textContent = message;
  const copy = document.createElement('button');
  copy.className = 'toast-action';
  copy.type = 'button';
  copy.textContent = t('toastAction.copy');
  copy.setAttribute('aria-label', t('toastAction.copyLabel'));
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.textContent = t('toastAction.close');
  close.setAttribute('aria-label', t('toastAction.closeLabel'));
  const undoButton = undo ? document.createElement('button') : null;
  if (undoButton && undo) { undoButton.className = 'toast-action toast-undo'; undoButton.type = 'button'; undoButton.textContent = undo.label; }
  toast.append(content, ...(undoButton ? [undoButton] : []), copy, close);
  document.body.append(toast);
  toast.showPopover?.();
  // An undo affordance the reader cannot reach in time is worse than none, so it gets a longer window.
  let remaining = undo ? 7_000 : 3_200;
  let deadline = Date.now() + remaining;
  let timer: number | undefined;
  let hovering = false;
  let focused = false;
  const dismiss = () => { if (timer !== undefined) window.clearTimeout(timer); toast.hidePopover?.(); toast.remove(); };
  const resume = () => { if (!toast.isConnected || hovering || focused || timer !== undefined) return; deadline = Date.now() + remaining; timer = window.setTimeout(dismiss, remaining); };
  const pause = () => { if (timer === undefined) return; window.clearTimeout(timer); timer = undefined; remaining = Math.max(0, deadline - Date.now()); };
  toast.addEventListener('pointerenter', () => { hovering = true; pause(); });
  toast.addEventListener('pointerleave', () => { hovering = false; resume(); });
  toast.addEventListener('focusin', () => { focused = true; pause(); });
  toast.addEventListener('focusout', event => { if (!toast.contains(event.relatedTarget as Node | null)) { focused = false; resume(); } });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(message); copy.textContent = t('toastAction.copied'); }
    catch { copy.textContent = t('toastAction.copyFailed'); }
  });
  close.addEventListener('click', dismiss);
  undoButton?.addEventListener('click', () => { dismiss(); undo?.onUndo(); });
  resume();
}
