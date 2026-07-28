export type Locale = 'en' | 'zh';

const LOCALE_KEY = 'pr-helper-locale';
const DEFAULT_LOCALE: Locale = 'en';

let currentLocale: Locale = (localStorage.getItem(LOCALE_KEY) as Locale) || DEFAULT_LOCALE;

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  localStorage.setItem(LOCALE_KEY, locale);
}

export function detectLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_KEY) as Locale | null;
  if (stored === 'en' || stored === 'zh') return stored;
  return navigator.language.startsWith('zh') ? 'zh' : 'en';
}

export type TranslationDict = Record<string, string>;

const translations: Record<Locale, TranslationDict> = {
  en: {},
  zh: {},
};

export function registerTranslations(locale: Locale, dict: TranslationDict): void {
  translations[locale] = dict;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const dict = translations[currentLocale] || translations[DEFAULT_LOCALE];
  let value = dict[key] ?? translations[DEFAULT_LOCALE][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replaceAll(`{${k}}`, String(v));
    }
  }
  return value;
}
