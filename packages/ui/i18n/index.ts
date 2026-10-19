export type { UILanguage, LanguageOption, TranslationDictionary } from './types';
export { SUPPORTED_LANGUAGES } from './types';
export { en } from './locales/en';
export { zhCN } from './locales/zh-CN';
export {
  I18nProvider,
  useTranslation,
  useI18n,
  resolveLanguage,
  type I18nContextValue,
} from './context';
