import { t } from './i18n';

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function prReferenceHtml(url: string, label: string, className = '') {
  const classes = `pr-ref${className ? ` ${className}` : ''}`;
  return `<button type="button" class="${classes}" data-pr-url="${escapeHtml(url)}" aria-label="${escapeHtml(t('prRef.aria', { label }))}">${escapeHtml(label)}</button>`;
}

async function writeClipboard(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* Falls through to the selection-based path below. */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.className = 'pr-ref-clipboard-helper';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

let tip: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;
let hideTimer: number | undefined;

function cancelHide() {
  if (hideTimer !== undefined) { window.clearTimeout(hideTimer); hideTimer = undefined; }
}

function removeTip() {
  cancelHide();
  tip?.remove();
  tip = null;
  anchor = null;
}

function place(element: HTMLElement, rect: DOMRect) {
  const box = element.getBoundingClientRect();
  const edge = 8;
  const left = Math.min(Math.max(edge, rect.left + rect.width / 2 - box.width / 2), window.innerWidth - box.width - edge);
  const above = rect.top - box.height - 6;
  element.style.left = `${left}px`;
  element.style.top = `${above < edge ? rect.bottom + 6 : above}px`;
}

function chipFrom(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>('.pr-ref') : null;
}

function showTip(chip: HTMLElement) {
  const url = chip.dataset.prUrl;
  if (!url) return;
  cancelHide();
  if (tip && anchor === chip) { place(tip, chip.getBoundingClientRect()); return; }
  removeTip();
  tip = document.createElement('div');
  tip.className = 'pr-ref-tip';
  tip.setAttribute('role', 'tooltip');
  tip.innerHTML = `<code>${escapeHtml(url)}</code><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(t('prRef.open'))}</a>`;
  tip.addEventListener('pointerenter', cancelHide);
  tip.addEventListener('pointerleave', scheduleHide);
  document.body.append(tip);
  anchor = chip;
  place(tip, chip.getBoundingClientRect());
}

function scheduleHide() {
  cancelHide();
  hideTimer = window.setTimeout(removeTip, 180);
}

export function initPrReferenceTooltip(notify: (message: string) => void) {
  if (document.querySelector('meta[name="pr-ref-tooltip"]')) return;
  const marker = document.createElement('meta');
  marker.name = 'pr-ref-tooltip';
  document.head.append(marker);

  document.addEventListener('pointerover', event => {
    const chip = chipFrom(event.target);
    if (chip) showTip(chip);
    else if (event.target !== tip && !(tip?.contains(event.target as Node))) scheduleHide();
  });
  document.addEventListener('focusin', event => { const chip = chipFrom(event.target); if (chip) showTip(chip); });
  document.addEventListener('focusout', event => { if (chipFrom(event.target)) scheduleHide(); });
  document.addEventListener('click', event => {
    const chip = chipFrom(event.target);
    if (!chip) return;
    event.preventDefault();
    const url = chip.dataset.prUrl || '';
    void writeClipboard(url).then(copied => notify(copied ? t('prRef.copied') : t('prRef.copyFailed')));
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') removeTip(); });
  window.addEventListener('scroll', removeTip, true);
  window.addEventListener('resize', removeTip);
}
