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

export function useStartGatewayAttempt(branchId: string | null, orderId: string) {
  return useMutation({
    mutationFn: (dto: { provider: string; idempotencyKey: string; amount?: number }) =>
      api.post<GatewayAttemptView>(
        `/payment-gateway/orders/${orderId}/attempts?branchId=${branchId}`,
        { method: "UPI", ...dto },
      ),
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
