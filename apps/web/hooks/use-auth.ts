"use client";

import { clearOfflineCache } from "@/lib/offline-cache";
import {
  permissionSatisfied,
  type LoginDto,
  type PinLoginDto,
  type RegisterDto,
  type SessionUser,
} from "@nventra/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { savedPushToken, savePushToken } from "@/lib/native";
import { api } from "@/lib/api";
import { forgetBranchChoice } from "@/hooks/use-branch";
import { rememberDeviceUser } from "@/lib/pin-keypad";

export function useCurrentUser() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<{ user: SessionUser }>("/auth/me"),
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: LoginDto) => api.post<{ user: SessionUser }>("/auth/login", dto),
    onSuccess: (data) => {
      // Anything cached before this login belongs to nobody (or to the previous
      // user): drop it so branches and the rest load fresh for this account.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
      queryClient.setQueryData(["auth", "me"], data);
      rememberDeviceUser(data.user);
    },
  });
}

/**
 * Shared-till quick switch: sign in as another staff member with their PIN.
 * The server replaces the session cookie; on success everything the previous
 * user had loaded (queries, offline snapshot, chosen branch) is dropped so the
 * new user never sees it.
 */
export function usePinLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: PinLoginDto) => api.post<{ user: SessionUser }>("/auth/pin-login", dto),
    onSuccess: (data) => {
      queryClient.clear();
      clearOfflineCache();
      forgetBranchChoice();
      queryClient.setQueryData(["auth", "me"], data);
      rememberDeviceUser(data.user);
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: RegisterDto) => api.post<{ user: SessionUser }>("/auth/register", dto),
    onSuccess: (data) => {
      queryClient.setQueryData(["auth", "me"], data);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Stop pushes to this phone before the session ends.
      const token = savedPushToken();
      if (token) {
        await api.delete(`/devices/${encodeURIComponent(token)}`).catch(() => undefined);
        savePushToken(null);
      }
      return api.post("/auth/logout");
    },
    onSuccess: () => {
      queryClient.clear();
      clearOfflineCache();
    },
  });
}

export function hasPermission(user: SessionUser | undefined, permission: string): boolean {
  return user ? permissionSatisfied(user.permissions, permission) : false;
}

/**
 * "Log out of all devices": the server bumps this user's token version, so
 * every session (this one included) stops working. Clears local state like
 * a normal sign-out.
 */
export function useRevokeMySessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>("/auth/sessions/revoke"),
    onSuccess: () => {
      savePushToken(null);
      queryClient.clear();
      clearOfflineCache();
      forgetBranchChoice();
    },
  });
}

/** Admin: sign a staff member out on every device (needs users.manage). */
export function useRevokeStaffSessions() {
  return useMutation({
    mutationFn: (userId: string) => api.post(`/auth/sessions/revoke/${encodeURIComponent(userId)}`),
  });
}
