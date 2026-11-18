"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface Schedule {
  id: string;
  reportKey: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  format: string;
  recipients: string[];
  isActive: boolean;
  lastSentAt: string | null;
  lastError: string | null;
}

const WHEN_KEY = { DAILY: "reports.sched.whenDaily", WEEKLY: "reports.sched.whenWeekly", MONTHLY: "reports.sched.whenMonthly" } as const;

export function SchedulesPanel({
  branchId,
  reportKey,
  titles,
}: {
  branchId: string | null;
  reportKey: string;
  titles: Record<string, string>;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [frequency, setFrequency] = useState<Schedule["frequency"]>("WEEKLY");
  const [format, setFormat] = useState("xlsx");
  const [recipients, setRecipients] = useState("");
  const { data } = useQuery({
    queryKey: ["report-schedules", branchId],
    queryFn: () => api.get<{ emailConfigured: boolean; schedules: Schedule[] }>(`/report-schedules?branchId=${branchId}`),
    enabled: !!branchId,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["report-schedules"] });
  const msg = (e: unknown) => (e instanceof ApiError ? e.message : t("reports.error"));

  const create = useMutation({
    mutationFn: () =>
      api.post(`/report-schedules?branchId=${branchId}`, {
        reportKey,
        frequency,
        format,
        recipients: recipients.split(/[,\s;]+/).filter(Boolean),
      }),
    onSuccess: () => {
      setRecipients("");
      refresh();
      toast.success(t("reports.sched.created"));
    },
    onError: (e) => toast.error(msg(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.patch(`/report-schedules/${id}?branchId=${branchId}`, { isActive }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/report-schedules/${id}?branchId=${branchId}`),
    onSuccess: refresh,
  });
  const sendNow = useMutation({
    mutationFn: (id: string) => api.post(`/report-schedules/${id}/send?branchId=${branchId}`),
    onSuccess: () => {
      refresh();
      toast.success(t("reports.sched.emailed"));
    },
    onError: (e) => toast.error(msg(e)),
  });
  const sel = "h-9 rounded-lg border border-border bg-background px-2 text-sm";

  return (
    <Card className="flex flex-col gap-4 p-4 print:hidden">
      <div>
        <h3 className="font-medium text-foreground">{t("reports.sched.title")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("reports.sched.smtp")}
          {data && !data.emailConfigured && ` ${t("reports.sched.noEmail")}`}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <select aria-label={t("reports.sched.frequency")} className={sel} value={frequency} onChange={(e) => setFrequency(e.target.value as Schedule["frequency"])}>
          <option value="DAILY">{t("reports.sched.daily")}</option>
          <option value="WEEKLY">{t("reports.sched.weekly")}</option>
          <option value="MONTHLY">{t("reports.sched.monthly")}</option>
        </select>
        <select aria-label={t("reports.sched.format")} className={sel} value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="xlsx">{t("reports.sched.xlsx")}</option>
          <option value="pdf">{t("reports.sched.pdf")}</option>
          <option value="csv">{t("reports.sched.csv")}</option>
        </select>
        <Input aria-label={t("reports.sched.recipients")} className="min-w-64 flex-1" placeholder={t("reports.sched.recipientsPlaceholder")} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
        <Button disabled={!recipients.trim() || create.isPending} onClick={() => create.mutate()}>{t("reports.sched.schedule")}</Button>
      </div>
      {data && data.schedules.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {data.schedules.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div>
                <p className="font-medium text-foreground">{titles[s.reportKey] ?? s.reportKey} <span className="font-normal text-muted-foreground">· {s.format.toUpperCase()} · {t(WHEN_KEY[s.frequency])}</span></p>
                <p className="text-xs text-muted-foreground">
                  {t("reports.sched.to", { list: s.recipients.join(", ") })}
                  {s.lastSentAt ? ` · ${t("reports.sched.lastSent", { when: s.lastSentAt.slice(0, 16).replace("T", " ") })}` : ""}
                  {s.lastError ? ` · ${s.lastError}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={sendNow.isPending} onClick={() => sendNow.mutate(s.id)}>{t("reports.sched.sendNow")}</Button>
                <Button size="sm" variant="outline" onClick={() => toggle.mutate({ id: s.id, isActive: !s.isActive })}>{s.isActive ? t("reports.sched.pause") : t("reports.sched.resume")}</Button>
                <Button size="sm" variant="outline" onClick={() => remove.mutate(s.id)}>{t("reports.sched.delete")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
