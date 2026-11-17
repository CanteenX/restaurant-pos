"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import type { DraftError, DraftField } from "@/lib/email-template-form";

const LINK_EXAMPLE = "{{reset.url}}";

export type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/** Translated message for a validation error from validateDraft. */
export function useDraftErrorText() {
  const { t } = useI18n();
  return (error: DraftError | undefined): string | null => {
    if (!error) return null;
    switch (error.code) {
      case "required":
        return t("settings.emailTemplates.error.required");
      case "tooLong":
        return t("settings.emailTemplates.error.tooLong");
      case "link":
        return t("settings.emailTemplates.error.link", { example: LINK_EXAMPLE });
      case "buttonPair":
        return t("settings.emailTemplates.error.buttonPair");
      case "placeholder":
        return t("settings.emailTemplates.error.placeholder", {
          names: (error.names ?? []).map((n) => `{{${n}}}`).join(", "),
        });
      default:
        return t("settings.emailTemplates.error.invalid");
    }
  };
}

const LABELS: Record<DraftField, TranslationKey> = {
  subject: "settings.emailTemplates.field.subject",
  heading: "settings.emailTemplates.field.heading",
  body: "settings.emailTemplates.field.body",
  buttonText: "settings.emailTemplates.field.buttonText",
  buttonUrl: "settings.emailTemplates.field.buttonUrl",
  footer: "settings.emailTemplates.field.footer",
};

interface TemplateFieldProps {
  field: DraftField;
  value: string;
  error: string | null;
  hint?: string;
  multiline?: boolean;
  inputRef: (el: FieldElement | null) => void;
  onChange: (value: string) => void;
  onFocus: () => void;
}

export function TemplateField({ field, value, error, hint, multiline, inputRef, onChange, onFocus }: TemplateFieldProps) {
  const { t } = useI18n();
  const id = `email-field-${field}`;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const shared = {
    id,
    name: field,
    value,
    ref: inputRef,
    onFocus,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {t(LABELS[field])}
      </label>
      {multiline ? <Textarea {...shared} rows={field === "body" ? 6 : 2} className="min-h-20" /> : <Input {...shared} />}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface PlaceholderChipsProps {
  names: readonly string[];
  onInsert: (name: string) => void;
}

export function PlaceholderChips({ names, onInsert }: PlaceholderChipsProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-foreground">{t("settings.emailTemplates.placeholders.title")}</p>
      <p className="text-xs text-muted-foreground">{t("settings.emailTemplates.placeholders.hint")}</p>
      <div className="flex flex-wrap gap-1.5" data-testid="placeholder-chips">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={t("settings.emailTemplates.placeholders.insert", { name })}
            // Keep focus (and the selection) in the field being edited.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(name)}
            className="max-w-full truncate rounded-full border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {`{{${name}}}`}
          </button>
        ))}
      </div>
    </div>
  );
}
