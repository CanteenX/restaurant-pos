// Pure helpers for the sales / table heat maps on the reports page.
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
type Cell = string | number | null;

export interface DayHourGrid {
  cells: number[][]; // [day 0=Sun][hour 0..23]
  max: number;
}

/** Bin `peak-hours` report rows ([Day, "HH:00", Orders, Sales]) into a 7x24 grid. */
export function binDayHour(rows: Cell[][], metric: "orders" | "sales"): DayHourGrid {
  const cells = DAY_LABELS.map(() => Array<number>(24).fill(0));
  for (const r of rows) {
    const d = DAY_LABELS.indexOf(String(r[0]) as (typeof DAY_LABELS)[number]);
    const h = Number.parseInt(String(r[1]), 10);
    const v = Number(metric === "orders" ? r[2] : r[3]);
    if (d < 0 || !Number.isInteger(h) || h < 0 || h > 23 || !Number.isFinite(v)) continue;
    cells[d][h] = Math.round((cells[d][h] + v) * 100) / 100;
  }
  return { cells, max: Math.max(0, ...cells.flat()) };
}

export const intensity = (v: number, max: number) => (max <= 0 ? 0 : Math.min(1, Math.max(0, v / max)));

// Light-to-dark blue ramp; text flips to white once the background is dark.
const RAMP: [number, number, number][] = [
  [239, 246, 255],
  [147, 197, 253],
  [59, 130, 246],
  [29, 78, 216],
  [23, 37, 84],
];

function lerp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f)) as [number, number, number];
}

const toHex = ([r, g, b]: number[]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

function luminance(hex: string) {
  const n = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = n.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function cellColor(t: number): { background: string; color: string } {
  const background = toHex(lerp(t));
  const color = contrastRatio(background, "#ffffff") >= contrastRatio(background, "#0f172a") ? "#ffffff" : "#0f172a";
  return { background, color };
}

export function legendSteps(max: number, n = 5) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { t, label: String(Math.round(max * t * 100) / 100) };
  });
}

/** Rank `table-turnover` rows ([Table, Orders, AvgMinutes]) busiest first. */
export function rankTables(rows: Cell[][]) {
  const list = rows
    .map((r) => ({ name: String(r[0]), orders: Number(r[1]) || 0, avgMinutes: Number(r[2]) || 0 }))
    .sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
  const max = list[0]?.orders ?? 0;
  return list.map((x) => ({ ...x, t: intensity(x.orders, max) }));
}
