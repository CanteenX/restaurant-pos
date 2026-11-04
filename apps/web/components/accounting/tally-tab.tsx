"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchTallyExport, useSaveTallyMapping, useTallyMapping } from "@/hooks/use-accounting";
import { ApiError } from "@/lib/api";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { toast } from "@/lib/toast";
import { mappingChanges, validateTallyRange } from "@/lib/tally-export";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const LABELS: Record<string, TranslationKey> = {
  sales: "acct.tally.ledger.sales", cgstOutput: "acct.tally.ledger.cgstOutput", sgstOutput: "acct.tally.ledger.sgstOutput",
  igstOutput: "acct.tally.ledger.igstOutput", roundOff: "acct.tally.ledger.roundOff", cash: "acct.tally.ledger.cash",
  card: "acct.tally.ledger.card", upi: "acct.tally.ledger.upi", wallet: "acct.tally.ledger.wallet",
  discount: "acct.tally.ledger.discount", serviceCharge: "acct.tally.ledger.serviceCharge", partyDefault: "acct.tally.ledger.partyDefault",
};

export function TallyTab({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : t("acct.error"));
  const now = new Date();
  const [range, setRange] = useState({ from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: iso(now) });
  const [busy, setBusy] = useState(false);
  const { data: saved } = useTallyMapping();
  const save = useSaveTallyMapping();
  const [note, setNote] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const draft = { ...saved, ...edits };

  const download = async () => {
    const invalid = validateTallyRange(range.from, range.to);
    if (invalid || !branchId) return toast.error(invalid ?? t("acct.tally.selectBranch"));
    setBusy(true);
    try {
      const { blob, filename } = await fetchTallyExport(branchId, range.from, range.to);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const changes = saved ? mappingChanges(saved, draft) : {};
  const saveMapping = () =>
    save.mutate(changes, { onSuccess: () => { setEdits({}); setNote(t("acct.tally.mappingSaved")); }, onError: (e) => toast.error(errMsg(e)) });

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">{t("acct.tally.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("acct.tally.intro")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" aria-label={t("acct.tally.from")} className="w-40" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <Input type="date" aria-label={t("acct.tally.to")} className="w-40" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <Button onClick={download} disabled={busy}>{busy ? t("acct.tally.preparing") : t("acct.tally.export")}</Button>
        </div>
      </Card>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">{t("acct.tally.mapping")}</h2>
        <p className="text-xs text-muted-foreground">{t("acct.tally.mappingHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(LABELS).map(([key, labelKey]) => (
            <label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t(labelKey)}
              <Input value={draft[key] ?? ""} maxLength={100} onChange={(e) => { setNote(""); setEdits({ ...edits, [key]: e.target.value }); }} />
            </label>
          ))}
        </div>
        <div>
          <Button onClick={saveMapping} disabled={save.isPending || Object.keys(changes).length === 0}>{t("acct.tally.saveMapping")}</Button>
          {note && <span role="status" className="ml-3 text-xs text-muted-foreground">{note}</span>}
        </div>
      </Card>
    </div>
  );
}
