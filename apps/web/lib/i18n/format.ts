// Locale-aware number/date/currency formatting via Intl. en and hi use the
// India region so amounts get lakh/crore grouping (1,23,45,678).
const INTL_TAGS: Record<string, string> = {
  en: "en-IN",
  hi: "hi-IN",
  es: "es-ES",
  fr: "fr-FR",
};

export function intlLocale(locale: string): string {
  return INTL_TAGS[locale] ?? locale;
}

export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

export function formatCurrency(value: number | string, locale: string, currency = "INR"): string {
  const amount = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(
  value: Date | string | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(new Date(value));
}
