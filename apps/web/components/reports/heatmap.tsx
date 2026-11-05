"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { binDayHour, cellColor, DAY_LABELS, intensity, legendSteps, rankTables } from "@/lib/heatmap";

type Rows = (string | number | null)[][];

function Legend({ max, unit }: { max: number; unit: string }) {
  const { t } = useI18n();
  return (
    <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground" data-testid="heatmap-legend" aria-label={t("reports.heat.scaleAria", { unit })}>
      <span>{t("reports.heat.low")}</span>
      {legendSteps(max).map((s) => {
        const c = cellColor(s.t);
        return (
          <span key={s.t} className="rounded px-2 py-0.5 tabular-nums" style={c}>
            {s.label}
          </span>
        );
      })}
      <span>{t("reports.heat.high", { unit })}</span>
    </div>
  );
}

export function DayHourHeatmap({ rows }: { rows: Rows }) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<"orders" | "sales">("orders");
  const grid = binDayHour(rows, metric);
  const unit = metric === "orders" ? t("reports.heat.unitOrders") : t("reports.heat.unitSales");
  return (
    <div data-testid="day-hour-heatmap" className="mb-4 overflow-x-auto">
      <div className="mb-2 flex gap-2 print:hidden" role="group" aria-label={t("reports.heat.metricAria")}>
        {(["orders", "sales"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={metric === m}
            onClick={() => setMetric(m)}
            className={`rounded-lg border border-border px-3 py-1 text-sm ${metric === m ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
          >
            {m === "orders" ? t("reports.heat.orders") : t("reports.heat.revenue")}
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
                  title={t("reports.heat.cellTitle", { day: d, hour: String(h).padStart(2, "0"), value: v, unit: unit })}
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
      <Legend max={grid.max} unit={unit} />
    </div>
  );
}

export function TableHeatmap({ rows }: { rows: Rows }) {
  const { t } = useI18n();
  const ranked = rankTables(rows);
  const max = ranked[0]?.orders ?? 0;
  return (
    <div data-testid="table-heatmap" className="mb-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
        {ranked.map((tbl) => (
          <div key={tbl.name} className="rounded-lg p-3 text-sm" style={cellColor(tbl.t)}>
            <p className="font-medium">{tbl.name}</p>
            <p className="tabular-nums">{t("reports.heat.tableOrders", { count: tbl.orders })}</p>
            <p className="text-xs tabular-nums">{t("reports.heat.tableAvg", { minutes: tbl.avgMinutes })}</p>
          </div>
        ))}
      </div>
      <Legend max={max} unit={t("reports.heat.unitOrders")} />
    </div>
  );
}
