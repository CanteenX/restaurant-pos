"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface SyncStatus {
  enabled: boolean;
  role: "client" | "server";
  serverUrl: string | null;
  hasKey: boolean;
  /** This install has its own key from HQ (#82). */
  registered: boolean;
  /** Branches this install runs (client) — HQ grants them at registration. */
  branchIds: string[];
  lastSyncAt: string | null;
  lastError: string | null;
  /** "schema" / "clock": transfer waits until fixed; changes keep queuing. */
  pausedReason: "schema" | "clock" | null;
  /** Failed cycles in a row; the next try waits 30 s doubling to 10 min. */
  failures: number;
  nextAttemptAt: string | null;
  pendingChanges: number;
  rejectedChanges: number;
  /** HQ: settled branch orders whose lines, total and payments disagree. */
  flaggedOrders: number;
  /** HQ: registered branch installs. */
  peers: number;
  conflicts: { tbl: string; pk: string; error: string; at: string }[];
}

export interface SyncConnection {
  serverUrl: string;
  apiKey: string;
  /** Branches this install runs; optional when HQ has only one. */
  branchIds?: string[];
}

export function useSyncStatus() {
  return useQuery({
    queryKey: ["sync", "status"],
    queryFn: () => api.get<SyncStatus>("/sync/status"),
    refetchInterval: 10_000,
  });
}

export function useTestSync() {
  return useMutation({
    mutationFn: (body: SyncConnection) => api.post<{ ok: boolean }>("/sync/test", body),
  });
}

export function useEnableSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SyncConnection & { mode: "adopt" | "merge" }) =>
      api.put<SyncStatus>("/sync/settings", body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sync"] }),
  });
}

export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SyncStatus & { pulled: number; pushed: number }>("/sync/run"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sync"] }),
  });
}

export function useDisableSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SyncStatus>("/sync/disable"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sync"] }),
  });
}
