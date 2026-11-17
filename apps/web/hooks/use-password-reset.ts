"use client";

import type { PasswordResetConfirmDto, PasswordResetRequestDto } from "@nventra/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const BASE = "/auth/password-reset";

/** Whether this server can email reset links (SMTP + PUBLIC_URL set). */
export function usePasswordResetEnabled() {
  return useQuery({
    queryKey: ["auth", "password-reset-enabled"],
    queryFn: () => api.get<{ enabled: boolean }>(`${BASE}/enabled`),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Always resolves to the same answer for any address (no enumeration). */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (dto: PasswordResetRequestDto) => api.post<{ ok: true }>(`${BASE}/request`, dto),
  });
}

export function useConfirmPasswordReset() {
  return useMutation({
    mutationFn: (dto: PasswordResetConfirmDto) => api.post<{ ok: true }>(`${BASE}/confirm`, dto),
  });
}

/**
 * Reads `#token=...` from the address bar once, then removes it so the
 * secret does not stay in the history or get copied with the URL.
 */
export function takeTokenFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token");
  if (token) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return token;
}
