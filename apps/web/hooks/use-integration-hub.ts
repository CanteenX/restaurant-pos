"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntegrationItemMapPatchDto } from "@nventra/types";
import { api } from "@/lib/api";

export type IntegrationStatus =
  | "NOT_CONNECTED"
  | "PENDING_CONFIGURATION"
  | "CONNECTED"
  | "SYNC_ERROR"
  | "AUTH_EXPIRED"
  | "DISABLED";

export interface IntegrationConnection {
  id: string;
  enabled: boolean;
  status: IntegrationStatus;
  externalAccountId: string | null;
  /** Which secret fields are set. The values themselves never leave the server. */
  credentialsSet: Record<string, boolean>;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Our menu item id -> the platform's item id. */
  itemMap: Record<string, string>;
  /** Platform calls queued (pending) and given up (dead). */
  outbox: { pending: number; dead: number };
  /** When the newest order from this channel arrived. */
  lastOrderAt: string | null;
}

export interface IntegrationProviderInfo {
  key: string;
  name: string;
  category: string;
  description: string;
  capabilities: Record<string, boolean>;
  accountIdLabel: string | null;
  requirements: string | null;
  /** Path of the signed inbound webhook for this restaurant, when the provider receives orders. */
  webhookPath: string | null;
  credentialFields: { key: string; label: string; secret: boolean; required: boolean; help?: string }[];
  connection: IntegrationConnection | null;
}

export interface IntegrationLogRow {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  event: string;
  message: string;
  createdAt: string;
}

const KEY = ["integration-hub"];

export function useIntegrationHub() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<IntegrationProviderInfo[]>("/integration-hub") });
}

export function useIntegrationLogs(provider: string | null) {
  return useQuery({
    queryKey: [...KEY, "logs", provider],
    queryFn: () => api.get<IntegrationLogRow[]>(`/integration-hub/${provider}/logs`),
    enabled: !!provider,
  });
}

export function useIntegrationActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    save: useMutation({
      mutationFn: (v: { provider: string; externalAccountId?: string; credentials: Record<string, string> }) =>
        api.put(`/integration-hub/${v.provider}`, { externalAccountId: v.externalAccountId, credentials: v.credentials }),
      onSuccess: done,
    }),
    test: useMutation({
      mutationFn: (provider: string) =>
        api.post<{ ok: boolean; message: string }>(`/integration-hub/${provider}/test`),
      onSuccess: done,
      onError: done,
    }),
    setEnabled: useMutation({
      mutationFn: (v: { provider: string; enabled: boolean }) =>
        api.post(`/integration-hub/${v.provider}/enabled`, { enabled: v.enabled }),
      onSuccess: done,
    }),
    /** Merged on the server: only the dishes named here change. */
    patchItemMap: useMutation({
      mutationFn: (v: { provider: string; patch: IntegrationItemMapPatchDto }) =>
        api.patch(`/integration-hub/${v.provider}/item-map`, v.patch),
      onSuccess: done,
    }),
    retryFailed: useMutation({
      mutationFn: (provider: string) => api.post<{ requeued: number }>(`/integration-hub/${provider}/outbox/retry`),
      onSuccess: done,
    }),
    disconnect: useMutation({
      mutationFn: (provider: string) => api.delete(`/integration-hub/${provider}`),
      onSuccess: done,
    }),
  };
}
