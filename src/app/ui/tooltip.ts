import { t } from '../../lib/i18n';

export let nativeOnlyTooltip: HTMLElement | null = null;
export function positionNativeOnlyTooltip(event: MouseEvent) {
  if (!nativeOnlyTooltip) return;
  nativeOnlyTooltip.style.left = '0px'; nativeOnlyTooltip.style.top = '0px';
  const rect = nativeOnlyTooltip.getBoundingClientRect();
  nativeOnlyTooltip.style.left = `${Math.max(8, event.clientX - rect.width)}px`;
  nativeOnlyTooltip.style.top = `${Math.max(8, event.clientY - rect.height)}px`;
}
export function showNativeOnlyTooltip(event: MouseEvent) {
  nativeOnlyTooltip ||= Object.assign(document.createElement('div'), { className: 'native-only-tooltip', role: 'tooltip', textContent: t('nativeOnly.tooltip') });
  if (!nativeOnlyTooltip.isConnected) document.body.append(nativeOnlyTooltip);
  nativeOnlyTooltip.hidden = false;
  positionNativeOnlyTooltip(event);
}
export function moveNativeOnlyTooltip(event: MouseEvent) { positionNativeOnlyTooltip(event); }
export function hideNativeOnlyTooltip() { if (nativeOnlyTooltip) nativeOnlyTooltip.hidden = true; }
