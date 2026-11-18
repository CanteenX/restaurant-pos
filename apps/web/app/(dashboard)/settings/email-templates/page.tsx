"use client";

import { useCallback, useState } from "react";
import type { EmailTemplateKey, EmailTemplateView } from "@nventra/types";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { BrandingCard } from "@/components/settings/email-templates/branding-card";
import { TemplateEditor, type Notify } from "@/components/settings/email-templates/template-editor";
import { TemplateList, templateNameKey } from "@/components/settings/email-templates/template-list";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusNote, useStatusNote } from "@/components/ui/status-note";
import { useEmailBranding, useEmailTemplateActions, useEmailTemplates } from "@/hooks/use-email-templates";
import { draftFromView, draftToDto } from "@/lib/email-template-form";
import { useI18n } from "@/lib/i18n/context";

export default function EmailTemplatesPage() {
  const { t } = useI18n();
  const templates = useEmailTemplates();
  const branding = useEmailBranding();
  const { save } = useEmailTemplateActions();
  const { note, show, clear } = useStatusNote();
  const [selected, setSelected] = useState<EmailTemplateKey | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingKey, setPendingKey] = useState<EmailTemplateKey | null>(null);

  const notify: Notify = useCallback((kind, text) => show(kind, text), [show]);
  const list = templates.data ?? [];
  const current = list.find((v) => v.key === selected) ?? list[0];

  const onToggle = (view: EmailTemplateView, enabled: boolean) => {
    setPendingKey(view.key);
    save.mutate(
      { key: view.key, dto: draftToDto({ ...draftFromView(view), enabled }) },
      {
        onError: () => notify("error", t("settings.emailTemplates.actions.saveError")),
        onSettled: () => setPendingKey(null),
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.emailTemplates.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.emailTemplates.subtitle")}</p>
      </div>
      <SettingsTabs />

      <StatusNote note={note} onClear={clear} />

      {templates.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("settings.emailTemplates.error.load")}
        </p>
      ) : !current ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <TemplateList
            templates={list}
            selected={current.key}
            selectedDirty={dirty}
            pendingKey={pendingKey}
            onSelect={(key) => {
              setSelected(key);
              setDirty(false);
            }}
            onToggle={onToggle}
          />
          <TemplateEditor
            // A new version (save, reset, toggle) restarts the draft from the saved values.
            key={`${current.key}:${current.updatedAt ?? "default"}:${current.enabled}`}
            view={current}
            name={t(templateNameKey(current.key))}
            notify={notify}
            onDirtyChange={setDirty}
          />
        </div>
      )}

      {branding.data && (
        <BrandingCard key={JSON.stringify(branding.data)} view={branding.data} notify={notify} />
      )}
    </div>
  );
}
