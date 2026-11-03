"use client";

// Lightweight client-side i18n (2026-09-27) — no routing/middleware
// involved, since this dashboard is a client-rendered SPA-style app and
// the QR ordering page is the one page a guest actually reads in their
// own language. A locale is just a piece of client state, persisted to
// localStorage so it survives a refresh, with a small dictionary lookup.
//
// Extending this: add a namespaced key (e.g. "menu.addItem") to en.json
// (and es/fr), then call t("menu.addItem") wherever the English literal
// used to be. Keys are typed from en.json. hi.json may lag: a missing key
// falls back to English and warns once in development. Full conventions:
// docs/I18N.md. Pure logic lives in translate.ts / format.ts.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";
import { createTranslator, type Dictionary, type Vars } from "./translate";
import * as fmt from "./format";
import en from "./dictionaries/en.json";
import es from "./dictionaries/es.json";
import fr from "./dictionaries/fr.json";
import hi from "./dictionaries/hi.json";

/** Every key that exists in the English source dictionary. */
export type TranslationKey = keyof typeof en;

const DICTIONARIES: Record<Locale, Dictionary> = { en, hi, es, fr };

function warnMissing(key: string, locale: string) {
  if (process.env.NODE_ENV === "production") return;
  console.warn(`[i18n] missing "${key}" for locale "${locale}" (using English)`);
}
const STORAGE_KEY = "nodedr-locale";

function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  for (const lang of navigator.languages ?? [navigator.language]) {
    const short = lang.slice(0, 2).toLowerCase();
    if (isLocale(short)) return short;
  }
  return DEFAULT_LOCALE;
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, vars?: Vars) => string;
  /** Plural form: `base.one` / `base.other` in the dictionary, `{count}` injected. */
  plural: (base: string, count: number, vars?: Vars) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (value: number | string, currency?: string) => string;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  fixedLocale,
}: {
  children: React.ReactNode;
  /**
   * Pins the starting language and never reads or writes the saved choice or
   * the browser language — for a shared public screen (the kiosk), where one
   * customer's language pick must not leak into the staff UI or stick for the
   * next customer.
   */
  fixedLocale?: Locale;
}) {
  // Starts at the fixed default on both server and first client render
  // (so hydration matches), then swaps to the saved/browser locale right
  // after mount — the same pattern the QR page already uses for
  // sessionStorage reads.
  const [locale, setLocaleState] = useState<Locale>(fixedLocale ?? DEFAULT_LOCALE);

  useEffect(() => {
    if (fixedLocale) return;
    const saved = localStorage.getItem(STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocaleState(isLocale(saved) ? saved : detectBrowserLocale());
  }, [fixedLocale]);

  const setLocale = useCallback(
    (next: Locale) => {
      if (!fixedLocale) localStorage.setItem(STORAGE_KEY, next);
      setLocaleState(next);
    },
    [fixedLocale],
  );

  // Screen readers and font selection (Devanagari) follow the UI language.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => {
    const translate = createTranslator(DICTIONARIES, locale, { onMissing: warnMissing });
    return {
      locale,
      setLocale,
      t: translate,
      plural: translate.plural,
      formatNumber: (v, o) => fmt.formatNumber(v, locale, o),
      formatCurrency: (v, c) => fmt.formatCurrency(v, locale, c),
      formatDate: (v, o) => fmt.formatDate(v, locale, o),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export { LOCALES, LOCALE_LABELS } from "./locales";
export type { Locale } from "./locales";
