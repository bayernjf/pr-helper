import { t } from '../../lib/i18n';
import { escape } from '../dom';

export function positionMergeMenu(menu: HTMLElement, control: HTMLElement) {
  menu.classList.remove('opens-upward');
  menu.style.maxHeight = '';
  const controlRect = control.getBoundingClientRect();
  const menuHeight = menu.getBoundingClientRect().height;
  const spaceBelow = window.innerHeight - controlRect.bottom - 8;
  const spaceAbove = controlRect.top - 8;
  const opensUpward = menuHeight > spaceBelow && spaceAbove > spaceBelow;
  menu.classList.toggle('opens-upward', opensUpward);
  const availableSpace = opensUpward ? spaceAbove : spaceBelow;
  if (menuHeight > availableSpace) menu.style.maxHeight = `${Math.max(96, Math.floor(availableSpace))}px`;
}
export function confirmDialog(eyebrow: string, title: string, description: string, cancelLabel: string, confirmLabel: string) {
  return new Promise<boolean>(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'create-dialog confirm-dialog';
    dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${eyebrow}</p><h2>${title}</h2><p>${description}</p><div class="dialog-actions"><button value="cancel" class="ghost">${cancelLabel}</button><button value="confirm" class="primary">${confirmLabel}</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'confirm'); dialog.remove(); }, { once: true });
  });
}

export function confirmAutoCreateExecution(source: string, target: string, ruleName: string) {
  return confirmDialog(t('automation.confirm.eyebrow'), t('automation.confirm.title'), t('automation.confirm.desc', { source: escape(source), target: escape(target), rule: escape(ruleName) }), t('automation.confirm.cancel'), t('automation.confirm.confirm'));
}

export function confirmRepositorySwitch(name: string, repository: string) {
  return confirmDialog(t('editor.repoSwitch.eyebrow'), t('editor.repoSwitch.title', { repository: escape(repository) }), t('editor.repoSwitch.desc', { repository: escape(repository), name: escape(name) }), t('editor.repoSwitch.cancel'), t('editor.repoSwitch.confirm'));
}
