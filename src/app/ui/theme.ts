import { t } from '../../lib/i18n';

export const THEME_KEY = 'pr-helper-theme';
export type Theme = 'light' | 'dark';
export let currentTheme: Theme = (localStorage.getItem(THEME_KEY) as Theme) || 'light';
export function applyTheme(theme: Theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeToggleButton();
}
export function toggleTheme() {
  applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}
export function updateThemeToggleButton() {
  const button = document.querySelector<HTMLButtonElement>('#theme-toggle');
  if (!button) return;
  const sunIcon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const moonIcon = '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z"/></svg>';
  const isDark = currentTheme === 'dark';
  button.innerHTML = `${isDark ? sunIcon : moonIcon}<span>${isDark ? t('theme.light') : t('theme.dark')}</span>`;
  button.setAttribute('aria-label', isDark ? t('theme.toLight') : t('theme.toDark'));
}
