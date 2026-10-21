import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UILanguage, TranslationDictionary } from './types';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import { useConfigValue } from '../config';

const dictionaries: Record<'en' | 'zh-CN', TranslationDictionary> = {
  en,
  'zh-CN': zhCN,
};

export function resolveLanguage(lang: UILanguage): 'en' | 'zh-CN' {
  if (lang === 'auto') {
    if (typeof navigator !== 'undefined' && navigator.language) {
      const lower = navigator.language.toLowerCase();
      if (lower.startsWith('zh')) return 'zh-CN';
    }
    return 'en';
  }
  return lang === 'zh-CN' ? 'zh-CN' : 'en';
}

function getNestedValue(obj: unknown, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export interface I18nContextValue {
  language: UILanguage;
  resolvedLanguage: 'en' | 'zh-CN';
  setLanguage: (lang: UILanguage) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [uiLanguage, setUILanguage] = useConfigValue('uiLanguage');
  const resolved = resolveLanguage(uiLanguage);

  const value = useMemo<I18nContextValue>(() => {
    const dict = dictionaries[resolved] || dictionaries.en;
    const fallbackDict = dictionaries.en;

    const t = (path: string, params?: Record<string, string | number>): string => {
      let text = getNestedValue(dict, path) ?? getNestedValue(fallbackDict, path) ?? path;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    };

    return {
      language: uiLanguage,
      resolvedLanguage: resolved,
      setLanguage: setUILanguage,
      t,
    };
  }, [uiLanguage, setUILanguage, resolved]);

  return React.createElement(I18nContext.Provider, { value }, children);
}

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Graceful fallback if used outside of I18nProvider
    const resolved = resolveLanguage('auto');
    const dict = dictionaries[resolved] || dictionaries.en;
    return {
      language: 'auto',
      resolvedLanguage: resolved,
      setLanguage: () => {},
      t(path: string, params?: Record<string, string | number>): string {
        let text = getNestedValue(dict, path) ?? path;
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        }
        return text;
      },
    };
  }
  return ctx;
}

export const useI18n = useTranslation;
