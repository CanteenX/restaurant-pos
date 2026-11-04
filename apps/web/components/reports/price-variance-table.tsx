"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_VARIANCE_THRESHOLD,
  filterVarianceRows,
  isHighVariance,
  isVarianceColumn,
  type VarianceCell,
} from "@/lib/price-variance";
import { cn } from "@/lib/utils";

interface Props {
  columns: string[];
  rows: VarianceCell[][];
  csvHref: string | null;
}

export function PriceVarianceTable({ columns, rows, csvHref }: Props) {
  const [query, setQuery] = useState("");
  const [threshold, setThreshold] = useState(DEFAULT_VARIANCE_THRESHOLD);
  const [onlyHigh, setOnlyHigh] = useState(false);
  const shown = filterVarianceRows(rows, { query, onlyHigh, threshold });

  return (
    <div className="flex flex-col gap-3" data-testid="price-variance">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Input
          className="w-56"
          placeholder="Filter ingredient or supplier"
          aria-label="Filter ingredient or supplier"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Highlight at ±
          <Input
            type="number"
            min={0}
            className="w-20"
            aria-label="Variance threshold percent"
            value={threshold}
            onChange={(e) => setThreshold(Math.max(0, Number(e.target.value) || 0))}
          />
          %
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={onlyHigh} onChange={(e) => setOnlyHigh(e.target.checked)} />
          Only high variance
        </label>
        {csvHref && (
          <a
            href={csvHref}
            data-testid="price-variance-csv"
            className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm hover:bg-secondary"
          >
            <Download className="mr-2 h-4 w-4" /> CSV
          </a>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No rows match the filter.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th key={c} className="py-1 pr-4 font-medium">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-t border-border">
                {r.map((cell, j) => {
                  const high = isVarianceColumn(j) && typeof cell === "number" && isHighVariance(cell, threshold);
                  return (
                    <td
                      key={j}
                      data-variance={high ? "high" : undefined}
                      className={cn("py-1.5 pr-4 tabular-nums", high && "font-semibold text-destructive")}
                    >
                      {cell ?? "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
