import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { STORAGE_KEY, makeTranslator, normalizeLang, prefersChinese, resolveLang } from './core.js';
import './i18n.css';

/** The Chinese dictionary is a separate file, fetched only when it is needed. */
export async function loadDict(lang) {
  if (lang === 'zh-CN') return (await import('../locales/zh-CN.js')).default;
  return null;
}

/** Language and dictionary for the first render, so a Chinese visitor never sees English flash first. */
export async function startingLanguage() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage blocked: fall back to English */
  }
  const lang = resolveLang({ search: location.search, stored });
  let dict = null;
  try {
    dict = await loadDict(lang);
  } catch {
    return { lang: 'en', dict: null }; // the dictionary failed to load: English still works
  }
  return { lang, dict };
}

// Strings the page asked for that the Chinese dictionary does not have. Read from the browser console as window.__i18nMissing.
const missing = new Set();
if (typeof window !== 'undefined') window.__i18nMissing = missing;

const I18nContext = createContext({ lang: 'en', t: makeTranslator(null), setLang: () => {} });
export const useI18n = () => useContext(I18nContext);

export function I18nProvider({ initialLang = 'en', initialDict = null, children }) {
  const [lang, setLangState] = useState(initialLang);
  const [dict, setDict] = useState(initialDict);

  const setLang = useCallback(async (next) => {
    const target = normalizeLang(next) ?? 'en';
    let d = null;
    try {
      d = await loadDict(target);
    } catch {
      return; // keep the current language if the dictionary cannot be fetched
    }
    try {
      localStorage.setItem(STORAGE_KEY, target);
    } catch {
      /* the choice just lasts for this visit */
    }
    // A link that carries ?lang= must not pull the page back to the old language on reload.
    try {
      const url = new URL(location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.set('lang', target === 'en' ? 'en' : 'zh');
        history.replaceState(null, '', url);
      }
    } catch {
      /* not worth failing for */
    }
    setDict(d);
    setLangState(target);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }, [lang]);

  const t = useMemo(() => makeTranslator(dict, (text) => missing.add(text)), [dict]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** EN / 中文 buttons. Always show both names in their own language, so a visitor can find their own. */
export function LangSwitch({ className = '' }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div className={`lang-switch ${className}`} role="group" aria-label={t('Language')}>
      <button type="button" lang="en" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
      <button type="button" lang="zh-CN" aria-pressed={lang === 'zh-CN'} onClick={() => setLang('zh-CN')}>中文</button>
    </div>
  );
}

/** A one-time offer for browsers set to Chinese. It never switches by itself. */
export function LangOffer() {
  const { lang, setLang } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    let decided = null;
    try {
      decided = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (lang === 'en' && !decided && prefersChinese(navigator.languages ?? [navigator.language])) setShow(true);
  }, [lang]);
  if (!show || lang !== 'en') return null;
  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'en');
    } catch {
      /* ignore */
    }
    setShow(false);
  };
  return (
    <div className="lang-offer" role="status">
      <span lang="zh-CN">查看中文版？</span>
      <span>View in Chinese?</span>
      <button type="button" onClick={() => { setShow(false); setLang('zh-CN'); }}>中文</button>
      <button type="button" className="lang-offer-close" aria-label="Dismiss" onClick={dismiss}>×</button>
    </div>
  );
}
