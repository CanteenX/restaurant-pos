// Pure translation core (no React), so it is unit-testable with node:test.
// context.tsx wraps it in a provider; see docs/I18N.md for key conventions.
import { DEFAULT_LOCALE } from "./locales.ts";
import { intlLocale } from "./format.ts";

export type Dictionary = Record<string, string>;
export type Vars = Record<string, string | number>;

export interface TranslatorOptions {
  /** Called once per (locale, key) that the active locale lacks. */
  onMissing?: (key: string, locale: string) => void;
}

export interface Translator {
  (key: string, vars?: Vars): string;
  /** Picks `${base}.${category}` by Intl.PluralRules (falls back to
   *  `${base}.other`) and injects a locale-formatted `{count}`. */
  plural: (base: string, count: number, vars?: Vars) => string;
}

/** Replaces every `{name}` with vars[name]; unknown placeholders stay. */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function createTranslator(
  dictionaries: Partial<Record<string, Dictionary>>,
  locale: string,
  options: TranslatorOptions = {},
): Translator {
  const active = dictionaries[locale] ?? {};
  const fallback = dictionaries[DEFAULT_LOCALE] ?? {};
  const reported = new Set<string>();

  const lookup = (key: string): string => {
    const hit = active[key];
    if (hit !== undefined) return hit;
    if (!reported.has(key)) {
      reported.add(key);
      options.onMissing?.(key, locale);
    }
    return fallback[key] ?? key;
  };

  const t = ((key: string, vars?: Vars) => interpolate(lookup(key), vars)) as Translator;

  const tag = intlLocale(locale);
  const rules = new Intl.PluralRules(tag);
  const numbers = new Intl.NumberFormat(tag);
  t.plural = (base, count, vars) => {
    const exact = `${base}.${rules.select(count)}`;
    const key = exact in active || exact in fallback ? exact : `${base}.other`;
    return interpolate(lookup(key), { ...vars, count: numbers.format(count) });
  };
  return t;
}
