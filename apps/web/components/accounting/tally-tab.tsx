"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchTallyExport, useSaveTallyMapping, useTallyMapping } from "@/hooks/use-accounting";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { mappingChanges, validateTallyRange } from "@/lib/tally-export";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong");
const LABELS: Record<string, string> = {
  sales: "Sales", cgstOutput: "CGST output", sgstOutput: "SGST output", igstOutput: "IGST output",
  roundOff: "Round off", cash: "Cash", card: "Card receipts", upi: "UPI receipts", wallet: "Wallet receipts",
  discount: "Discount allowed", serviceCharge: "Service charge", partyDefault: "Default party",
};

export function TallyTab({ branchId }: { branchId: string | null }) {
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
    if (invalid || !branchId) return toast.error(invalid ?? "Select a branch first");
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
    save.mutate(changes, { onSuccess: () => { setEdits({}); setNote("Ledger mapping saved"); }, onError: (e) => toast.error(errMsg(e)) });

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">Export to Tally</h2>
        <p className="text-xs text-muted-foreground">Sales, receipts and refunds for the range as a TallyPrime voucher import file.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" aria-label="From date" className="w-40" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <Input type="date" aria-label="To date" className="w-40" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <Button onClick={download} disabled={busy}>{busy ? "Preparing…" : "Export to Tally"}</Button>
        </div>
      </Card>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">Ledger mapping</h2>
        <p className="text-xs text-muted-foreground">Names must match the ledgers in your Tally books. Characters &lt; &gt; &amp; are not allowed.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(LABELS).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {label}
              <Input value={draft[key] ?? ""} maxLength={100} onChange={(e) => { setNote(""); setEdits({ ...edits, [key]: e.target.value }); }} />
            </label>
          ))}
        </div>
        <div>
          <Button onClick={saveMapping} disabled={save.isPending || Object.keys(changes).length === 0}>Save mapping</Button>
          {note && <span role="status" className="ml-3 text-xs text-muted-foreground">{note}</span>}
        </div>
      </Card>
    </div>
  );
}
