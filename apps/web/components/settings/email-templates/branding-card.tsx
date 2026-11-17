"use client";

import { useMemo, useState } from "react";
import { DEFAULT_EMAIL_PRIMARY_COLOR, emailBrandingSchema, type EmailBrandingView } from "@nventra/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useEmailTemplateActions } from "@/hooks/use-email-templates";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import type { Notify } from "./template-editor";

type BrandingField = "primaryColor" | "headerText" | "footerText" | "logoUrl" | "replyTo";
type BrandingDraft = Record<BrandingField, string>;

const LABELS: Record<BrandingField, TranslationKey> = {
  primaryColor: "settings.emailTemplates.branding.primaryColor",
  headerText: "settings.emailTemplates.branding.headerText",
  footerText: "settings.emailTemplates.branding.footerText",
  logoUrl: "settings.emailTemplates.branding.logoUrl",
  replyTo: "settings.emailTemplates.branding.replyTo",
};
const HINTS: Partial<Record<BrandingField, TranslationKey>> = {
  logoUrl: "settings.emailTemplates.branding.logoHint",
  replyTo: "settings.emailTemplates.branding.replyToHint",
};

function toDraft(view: EmailBrandingView): BrandingDraft {
  return {
    primaryColor: view.primaryColor,
    headerText: view.headerText ?? "",
    footerText: view.footerText ?? "",
    logoUrl: view.logoUrl ?? "",
    replyTo: view.replyTo ?? "",
  };
}

const nullIfBlank = (v: string) => (v.trim() ? v : null);

interface BrandingCardProps {
  view: EmailBrandingView;
  notify: Notify;
}

/** Keyed by the parent on the saved values, so a save resets the draft. */
export function BrandingCard({ view, notify }: BrandingCardProps) {
  const { t } = useI18n();
  const { saveBranding } = useEmailTemplateActions();
  const [draft, setDraft] = useState<BrandingDraft>(() => toDraft(view));
  const parsed = useMemo(
    () =>
      emailBrandingSchema.safeParse({
        primaryColor: draft.primaryColor,
        headerText: nullIfBlank(draft.headerText),
        footerText: nullIfBlank(draft.footerText),
        logoUrl: nullIfBlank(draft.logoUrl),
        replyTo: draft.replyTo.trim(),
      }),
    [draft],
  );

  const errorFor = (field: BrandingField): string | null => {
    if (parsed.success) return null;
    const issue = parsed.error.issues.find((i) => i.path[0] === field);
    if (!issue) return null;
    if (issue.code === "too_big") return t("settings.emailTemplates.error.tooLong");
    if (field === "primaryColor")
      return t("settings.emailTemplates.branding.error.primaryColor", { example: DEFAULT_EMAIL_PRIMARY_COLOR });
    if (field === "logoUrl") return t("settings.emailTemplates.branding.error.logoUrl");
    if (field === "replyTo") return t("settings.emailTemplates.branding.error.replyTo");
    return t("settings.emailTemplates.error.invalid");
  };

  const dirty = JSON.stringify(toDraft(view)) !== JSON.stringify(draft);
  const set = (field: BrandingField, value: string) => setDraft((d) => ({ ...d, [field]: value }));
  const validColor = /^#[0-9a-fA-F]{6}$/.test(draft.primaryColor) ? draft.primaryColor : DEFAULT_EMAIL_PRIMARY_COLOR;

  const onSave = () => {
    if (!parsed.success) return;
    // mutateAsync: the card is re-keyed on the refetch, which drops per-call callbacks.
    saveBranding
      .mutateAsync(parsed.data)
      .then(() => notify("success", t("settings.emailTemplates.branding.saved")))
      .catch(() => notify("error", t("settings.emailTemplates.branding.saveError")));
  };

  const textField = (field: BrandingField, type = "text") => {
    const id = `email-branding-${field}`;
    const error = errorFor(field);
    const hint = HINTS[field];
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {t(LABELS[field])}
        </label>
        <Input
          id={id}
          type={type}
          value={draft[field]}
          aria-invalid={error ? true : undefined}
          onChange={(e) => set(field, e.target.value)}
        />
        {hint && <p className="text-xs text-muted-foreground">{t(hint)}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  };

  const colorError = errorFor("primaryColor");
  return (
    <Card className="flex min-w-0 flex-col gap-4 p-4 sm:p-6" data-testid="email-branding">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("settings.emailTemplates.branding.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings.emailTemplates.branding.desc")}</p>
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="email-branding-primaryColor" className="text-sm font-medium text-foreground">
            {t(LABELS.primaryColor)}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={t(LABELS.primaryColor)}
              value={validColor.toLowerCase()}
              onChange={(e) => set("primaryColor", e.target.value.toUpperCase())}
              className="h-8 w-10 shrink-0 cursor-pointer rounded border border-input bg-transparent"
            />
            <Input
              id="email-branding-primaryColor"
              value={draft.primaryColor}
              aria-invalid={colorError ? true : undefined}
              onChange={(e) => set("primaryColor", e.target.value)}
              className="font-mono"
            />
          </div>
          {colorError && <p className="text-xs text-destructive">{colorError}</p>}
        </div>
        {textField("headerText")}
        {textField("logoUrl", "url")}
        {textField("replyTo", "email")}
        <div className="md:col-span-2">{textField("footerText")}</div>
      </div>
      <div>
        <Button onClick={onSave} disabled={!dirty || !parsed.success || saveBranding.isPending}>
          {t("settings.emailTemplates.branding.save")}
        </Button>
      </div>
    </Card>
  );
}
