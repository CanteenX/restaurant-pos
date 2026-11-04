"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { gatewayQrPhase, type GatewayAttemptView } from "@/lib/gateway-qr";

export interface AvailableGateway {
  key: string;
  name: string;
}

/** Connected, tested gateways this till may offer. Empty → static UPI QR. */
export function useAvailableGateways(enabled = true) {
  return useQuery({
    queryKey: ["payment-gateway", "available"],
    queryFn: () => api.get<AvailableGateway[]>("/payment-gateway/available"),
    enabled,
    staleTime: 60_000,
  });
}

const openKey = (orderId: string) => ["payment-gateway", "open", orderId];

export function useStartGatewayAttempt(branchId: string | null, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: { provider: string; idempotencyKey: string; amount?: number }) =>
      api.post<GatewayAttemptView>(
        `/payment-gateway/orders/${orderId}/attempts?branchId=${branchId}`,
        { method: "UPI", ...dto },
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: openKey(orderId) }),
  });
}

/**
 * The bill's still-payable gateway QR, as the server sees it (it checks with
 * the gateway on every call). This survives a reload, a table switch or a
 * method switch, so the till can resume the QR and hold manual payment.
 */
export function useOpenGatewayAttempt(branchId: string | null, orderId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: openKey(orderId),
    queryFn: async () => {
      const before = queryClient.getQueryData<{ attempt: GatewayAttemptView | null }>(openKey(orderId));
      const r = await api.get<{ attempt: GatewayAttemptView | null }>(
        `/payment-gateway/orders/${orderId}/attempts/open?branchId=${branchId}`,
      );
      // It was open and now is not: it was paid (and settled) or expired.
      if (before?.attempt && !r.attempt) {
        queryClient.invalidateQueries({ queryKey: ["orders"] });
        queryClient.invalidateQueries({ queryKey: ["floors"] });
      }
      return r;
    },
    enabled: enabled && !!branchId,
    refetchInterval: (q) => (q.state.data?.attempt ? 4_000 : false),
  });
}

/**
 * Polls the gateway while the guest is paying. Each poll asks the server to
 * check with the gateway, which settles the bill once the money is in.
 */
export function useGatewayAttempt(initial: GatewayAttemptView | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["payment-gateway", "attempt", initial?.id],
    queryFn: async () => {
      const a = await api.post<GatewayAttemptView>(`/payment-gateway/attempts/${initial!.id}/refresh`, {});
      if (a.settled) {
        queryClient.invalidateQueries({ queryKey: ["orders"] });
        queryClient.invalidateQueries({ queryKey: ["floors"] });
      }
      return a;
    },
    enabled: !!initial,
    initialData: initial ?? undefined,
    initialDataUpdatedAt: 0,
    refetchInterval: (q) => (gatewayQrPhase(q.state.data) === "waiting" ? 3_000 : false),
  });
}
