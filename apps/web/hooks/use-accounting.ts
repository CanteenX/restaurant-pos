"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { parseDownloadFilename, tallyExportPath, tallyFilename } from "@/lib/tally-export";

export interface ExpenseRow {
  id: string;
  spentOn: string;
  category: string;
  amount: string;
  note: string | null;
  paidFromCash: boolean;
}
export interface ClosingPreview {
  businessDate: string;
  openingFloat: number;
  cashSales: number;
  cashExpenses: number;
  expectedCash: number;
}
export interface ClosingRow {
  id: string;
  businessDate: string;
  expectedCash: string;
  countedCash: string;
  variance: string;
  note: string | null;
}
export interface ProfitLoss {
  orders: number;
  grossCollected: number;
  taxCollected: number;
  refunds: number;
  netSales: number;
  expenses: { category: string; amount: number }[];
  totalExpenses: number;
  payrollCost: number;
  netProfit: number;
}
export interface GstReport {
  orders: number;
  rows: { ratePercent: number; taxableValue: number; tax: number; total: number }[];
  totalTaxable: number;
  totalTax: number;
}
export interface BranchRow {
  branchId: string;
  name: string;
  orders: number;
  sales: number;
  openOrders: number;
  lowStockItems: number;
  inventoryValue: number;
}

const q = (b: string | null) => `branchId=${b}`;

export function useExpenses(branchId: string | null, from: string, to: string) {
  return useQuery({
    queryKey: ["acct", "expenses", branchId, from, to],
    queryFn: () => api.get<ExpenseRow[]>(`/accounting/expenses?${q(branchId)}&from=${from}&to=${to}`),
    enabled: !!branchId,
  });
}
export function useClosingPreview(branchId: string | null, date: string, openingFloat: number) {
  return useQuery({
    queryKey: ["acct", "preview", branchId, date, openingFloat],
    queryFn: () =>
      api.get<ClosingPreview>(`/accounting/closing/preview?${q(branchId)}&date=${date}&openingFloat=${openingFloat}`),
    enabled: !!branchId,
  });
}
export function useClosings(branchId: string | null) {
  return useQuery({
    queryKey: ["acct", "closings", branchId],
    queryFn: () => api.get<ClosingRow[]>(`/accounting/closing?${q(branchId)}`),
    enabled: !!branchId,
  });
}
export function useProfitLoss(branchId: string | null, from: string, to: string) {
  return useQuery({
    queryKey: ["acct", "pnl", branchId, from, to],
    queryFn: () => api.get<ProfitLoss>(`/accounting/profit-loss?${q(branchId)}&from=${from}&to=${to}`),
    enabled: !!branchId,
  });
}
export function useGst(branchId: string | null, from: string, to: string) {
  return useQuery({
    queryKey: ["acct", "gst", branchId, from, to],
    queryFn: () => api.get<GstReport>(`/accounting/gst?${q(branchId)}&from=${from}&to=${to}`),
    enabled: !!branchId,
  });
}
export function useBranchOverview(from: string, to: string) {
  return useQuery({
    queryKey: ["acct", "branches", from, to],
    queryFn: () => api.get<BranchRow[]>(`/accounting/branches?from=${from}&to=${to}`),
  });
}

export function useAccountingActions(branchId: string | null) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ["acct"] });
  return {
    addExpense: useMutation({
      mutationFn: (dto: { spentOn: string; category: string; amount: number; note?: string; paidFromCash: boolean }) =>
        api.post(`/accounting/expenses?${q(branchId)}`, dto),
      onSuccess: done,
    }),
    deleteExpense: useMutation({
      mutationFn: (id: string) => api.delete(`/accounting/expenses/${id}?${q(branchId)}`),
      onSuccess: done,
    }),
    closeDay: useMutation({
      mutationFn: (dto: { businessDate: string; openingFloat: number; countedCash: number; note?: string }) =>
        api.post(`/accounting/closing?${q(branchId)}`, dto),
      onSuccess: done,
    }),
  };
}

export type TallyMapping = Record<string, string>;

export function useTallyMapping() {
  return useQuery({
    queryKey: ["acct", "tally-mapping"],
    queryFn: () => api.get<TallyMapping>("/accounting/tally-mapping"),
  });
}
export function useSaveTallyMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: TallyMapping) => api.put<TallyMapping>("/accounting/tally-mapping", dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acct", "tally-mapping"] }),
  });
}

/** Fetches the Tally XML (with the session cookie) and returns it as a Blob + filename. */
export async function fetchTallyExport(branchId: string, from: string, to: string) {
  const res = await fetch(`/api/v1${tallyExportPath(branchId, from, to)}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(body.message ?? "Export failed", res.status);
  }
  return {
    blob: await res.blob(),
    filename: parseDownloadFilename(res.headers.get("Content-Disposition"), tallyFilename(from, to)),
  };
}
