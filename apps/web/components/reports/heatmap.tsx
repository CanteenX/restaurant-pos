"use client";

import { useState } from "react";
import { binDayHour, cellColor, DAY_LABELS, intensity, legendSteps, rankTables } from "@/lib/heatmap";

type Rows = (string | number | null)[][];

function Legend({ max, unit }: { max: number; unit: string }) {
  return (
    <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground" data-testid="heatmap-legend" aria-label={`Colour scale for ${unit}`}>
      <span>Low</span>
      {legendSteps(max).map((s) => {
        const c = cellColor(s.t);
        return (
          <span key={s.t} className="rounded px-2 py-0.5 tabular-nums" style={c}>
            {s.label}
          </span>
        );
      })}
      <span>High ({unit})</span>
    </div>
  );
}

export function DayHourHeatmap({ rows }: { rows: Rows }) {
  const [metric, setMetric] = useState<"orders" | "sales">("orders");
  const grid = binDayHour(rows, metric);
  return (
    <div data-testid="day-hour-heatmap" className="mb-4 overflow-x-auto">
      <div className="mb-2 flex gap-2 print:hidden" role="group" aria-label="Heat map metric">
        {(["orders", "sales"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={metric === m}
            onClick={() => setMetric(m)}
            className={`rounded-lg border border-border px-3 py-1 text-sm ${metric === m ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
          >
            {m === "orders" ? "Orders" : "Revenue"}
          </button>
        ))}
      </div>
      <table className="border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className="w-8 font-normal text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAY_LABELS.map((d, di) => (
            <tr key={d}>
              <th scope="row" className="pr-2 text-left font-normal text-muted-foreground">{d}</th>
              {grid.cells[di].map((v, h) => (
                <td
                  key={h}
                  data-testid="heat-cell"
                  data-value={v}
                  title={`${d} ${String(h).padStart(2, "0")}:00 — ${v} ${metric}`}
                  className="h-7 w-8 rounded text-center tabular-nums"
                  style={cellColor(intensity(v, grid.max))}
                >
                  {v > 0 ? Math.round(v) : ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Legend max={grid.max} unit={metric} />
    </div>
  );
}

export function TableHeatmap({ rows }: { rows: Rows }) {
  const ranked = rankTables(rows);
  const max = ranked[0]?.orders ?? 0;
  return (
    <div data-testid="table-heatmap" className="mb-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
        {ranked.map((t) => (
          <div key={t.name} className="rounded-lg p-3 text-sm" style={cellColor(t.t)}>
            <p className="font-medium">{t.name}</p>
            <p className="tabular-nums">{t.orders} orders</p>
            <p className="text-xs tabular-nums">{t.avgMinutes} min avg</p>
          </div>
        ))}
      </div>
      <Legend max={max} unit="orders" />
    </div>
  );
}
