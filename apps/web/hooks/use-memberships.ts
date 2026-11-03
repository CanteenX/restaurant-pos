"use client";

import type {
  MembershipBenefit,
  MembershipTierDto,
  MembershipTierUpdateDto,
} from "@nventra/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface MembershipTier {
  id: string;
  name: string;
  rank: number;
  discountPercent: string | number;
  pointsMultiplier: string | number;
  durationDays: number | null;
  description: string | null;
  active: boolean;
}

export interface MembershipHistoryRow {
  id: string;
  startsAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  tier: { id: string; name: string; rank: number };
}

export interface MembershipSummary {
  benefit: MembershipBenefit;
  history: MembershipHistoryRow[];
}

export function useMembershipTiers() {
  return useQuery({
    queryKey: ["memberships", "tiers"],
    queryFn: () => api.get<MembershipTier[]>("/memberships/tiers"),
  });
}

export function useCreateTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: MembershipTierDto) => api.post<MembershipTier>("/memberships/tiers", dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memberships", "tiers"] }),
  });
}

export function useUpdateTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: MembershipTierUpdateDto }) =>
      api.patch<MembershipTier>(`/memberships/tiers/${id}`, dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memberships", "tiers"] }),
  });
}

/** Branch-scoped membership summary; 403 (no customers.manage) leaves data undefined. */
export function useCustomerMembership(branchId: string | null, customerId: string | null) {
  return useQuery({
    queryKey: ["customers", branchId, "membership", customerId],
    queryFn: () => api.get<MembershipSummary>(`/customers/${customerId}/membership?branchId=${branchId}`),
    enabled: !!branchId && !!customerId,
    retry: false,
  });
}

export function useMembershipActions(branchId: string | null, customerId: string) {
  const qc = useQueryClient();
  const base = `/customers/${customerId}/membership`;
  const done = () => qc.invalidateQueries({ queryKey: ["customers", branchId, "membership", customerId] });
  const enrol = useMutation({
    mutationFn: (tierId: string) => api.post(`${base}?branchId=${branchId}`, { tierId }),
    onSuccess: done,
  });
  const upgrade = useMutation({
    mutationFn: (tierId: string) => api.post(`${base}/upgrade?branchId=${branchId}`, { tierId }),
    onSuccess: done,
  });
  const expire = useMutation({
    mutationFn: () => api.post(`${base}/expire?branchId=${branchId}`),
    onSuccess: done,
  });
  return { enrol, upgrade, expire };
}
