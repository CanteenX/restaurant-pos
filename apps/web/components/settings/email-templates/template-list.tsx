"use client";

import type { EmailTemplateKey, EmailTemplateView } from "@nventra/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { formatDate } from "@/lib/i18n/format";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export const templateNameKey = (key: EmailTemplateKey) => `settings.emailTemplates.name.${key}` as TranslationKey;
const audienceKey = (key: EmailTemplateKey) => `settings.emailTemplates.audience.${key}` as TranslationKey;

interface TemplateListProps {
  templates: EmailTemplateView[];
  selected: EmailTemplateKey;
  /** The selected template has unsaved edits: its toggle waits for Save. */
  selectedDirty: boolean;
  pendingKey: EmailTemplateKey | null;
  onSelect: (key: EmailTemplateKey) => void;
  onToggle: (view: EmailTemplateView, enabled: boolean) => void;
}

export function TemplateList({ templates, selected, selectedDirty, pendingKey, onSelect, onToggle }: TemplateListProps) {
  const { t, locale } = useI18n();
  return (
    <Card className="flex min-w-0 flex-col p-2">
      <div className="px-3 pt-2 pb-3">
        <h2 className="text-lg font-semibold text-foreground">{t("settings.emailTemplates.list.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings.emailTemplates.list.desc")}</p>
      </div>
      <ul className="flex flex-col gap-1" data-testid="email-template-list">
        {templates.map((tpl) => {
          const name = t(templateNameKey(tpl.key));
          const active = tpl.key === selected;
          return (
            <li
              key={tpl.key}
              data-testid={`email-template-${tpl.key}`}
              className={cn(
                "flex min-w-0 items-center gap-3 rounded-lg px-3 py-2",
                active ? "bg-primary/10" : "hover:bg-muted",
              )}
            >
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect(tpl.key)}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex max-w-full flex-wrap items-center gap-2">
                  <span className={cn("truncate text-sm font-medium", tpl.enabled ? "text-foreground" : "text-muted-foreground")}>
                    {name}
                  </span>
                  <Badge variant={tpl.isCustom ? "default" : "outline"}>
                    {tpl.isCustom ? t("settings.emailTemplates.badge.custom") : t("settings.emailTemplates.badge.default")}
                  </Badge>
                  {!tpl.enabled && <Badge variant="secondary">{t("settings.emailTemplates.list.off")}</Badge>}
                </span>
                <span className="max-w-full truncate text-xs text-muted-foreground">
                  {t(audienceKey(tpl.key))}
                  {tpl.updatedAt &&
                    ` · ${t("settings.emailTemplates.list.edited", { date: formatDate(tpl.updatedAt, locale) })}`}
                </span>
              </button>
              <Switch
                aria-label={t("settings.emailTemplates.list.toggle", { name })}
                checked={tpl.enabled}
                disabled={pendingKey === tpl.key || (active && selectedDirty)}
                onCheckedChange={(enabled) => onToggle(tpl, enabled)}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
