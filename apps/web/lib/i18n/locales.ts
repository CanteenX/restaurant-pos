// Supported UI languages (2026-09-27). Adding a language: add its code
// here, drop a matching dictionary file in ./dictionaries, register it in
// context.tsx, and it shows up in the language switcher. Missing keys fall
// back to English one key at a time (see translate.ts), so a new language
// can ship partially translated. Conventions: docs/I18N.md.
export const LOCALES = ["en", "hi", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  hi: "हिन्दी",
  es: "Español",
  fr: "Français",
};

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}
