"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface ReceiptEmailStatus {
  hasEmail: boolean;
  status?: "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";
  sendCount?: number;
  sentAt?: string | null;
  maskedEmail?: string;
}

/** Digital receipt delivery state of an order (the address is masked). */
export function useReceiptEmailStatus(orderId: string | null, branchId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["receipt-email", orderId],
    queryFn: () => api.get<ReceiptEmailStatus>(`/orders/${orderId}/receipt-email?branchId=${branchId}`),
    enabled: enabled && !!orderId && !!branchId,
    // The receipt goes out a moment after payment; keep checking until it has.
    refetchInterval: (query) =>
      ["PENDING", "SENDING"].includes(query.state.data?.status ?? "") ? 2000 : false,
  });
}

export function useResendReceiptEmail(orderId: string, branchId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ sent: true }>(`/orders/${orderId}/receipt-email/resend?branchId=${branchId}`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["receipt-email", orderId] }),
  });
}
