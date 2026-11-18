"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n/context";
import {
  DEFAULT_DASHBOARD_PREFS,
  TREND_DAY_OPTIONS,
  WIDGET_LABEL_KEYS,
  type DashboardPrefs,
} from "@/hooks/use-dashboard";

// Reordering uses plain buttons rather than drag and drop: they work with a
// keyboard, a screen reader and a touch screen, and need no extra library.
export function CustomizePanel({
  prefs,
  onChange,
  onClose,
  saving,
}: {
  prefs: DashboardPrefs;
  onChange: (next: DashboardPrefs) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const { t } = useI18n();
  const label = (id: string) => (id in WIDGET_LABEL_KEYS ? t(WIDGET_LABEL_KEYS[id]) : id);
  const move = (key: "topOrder" | "cardOrder", id: string, by: -1 | 1) => {
    const list = [...prefs[key]];
    const i = list.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    onChange({ ...prefs, [key]: list });
  };
  const toggle = (id: string) =>
    onChange({
      ...prefs,
      hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id],
    });

  const group = (title: string, key: "topOrder" | "cardOrder") => (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {prefs[key].map((id, i, all) => {
          const hidden = prefs.hidden.includes(id);
          return (
            <li key={id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className={hidden ? "text-sm text-muted-foreground line-through" : "text-sm text-foreground"}>
                {label(id)}
                {hidden && <span className="ml-2 text-xs no-underline">{t("dashboard.custom.hidden")}</span>}
              </span>
              <span className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={i === 0}
                  aria-label={t("dashboard.custom.moveUp", { name: label(id) })}
                  onClick={() => move(key, id, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={i === all.length - 1}
                  aria-label={t("dashboard.custom.moveDown", { name: label(id) })}
                  onClick={() => move(key, id, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-pressed={hidden}
                  aria-label={hidden ? t("dashboard.custom.show", { name: label(id) }) : t("dashboard.custom.hide", { name: label(id) })}
                  onClick={() => toggle(id)}
                >
                  {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <Card className="flex flex-col gap-4 p-5" role="region" aria-label={t("dashboard.custom.region")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[18px] font-medium text-foreground">{t("dashboard.custom.title")}</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onChange(DEFAULT_DASHBOARD_PREFS)}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t("dashboard.custom.restore")}
          </Button>
          <Button size="sm" onClick={onClose}>
            {t("common.done")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("dashboard.custom.note")}
        {` ${saving ? t("dashboard.custom.saving") : t("dashboard.custom.saved")}`}
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {group(t("dashboard.custom.mainSections"), "topOrder")}
        {group(t("dashboard.custom.cards"), "cardOrder")}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
        {t("dashboard.custom.chartPeriod")}
        <select
          value={prefs.trendDays}
          onChange={(e) => onChange({ ...prefs, trendDays: Number(e.target.value) })}
          className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
        >
          {TREND_DAY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {t("dashboard.custom.lastDays", { days: d })}
            </option>
          ))}
        </select>
      </label>
    </Card>
  );
}
