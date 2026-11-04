"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { UpdateProgress } from "@/lib/update-progress";

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  building?: boolean;
  releaseUrl: string | null;
  checkedAt: string;
}

export function useUpdateCheck(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["system", "update-check"],
    queryFn: () => api.get<VersionInfo>("/system/update/check"),
    // The backend caches this for an hour too — refetching more often than
    // that on the client just re-hits the same cached response.
    staleTime: 5 * 60 * 1000,
  });
}

export function useApplyUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ status: string; message: string }>("/system/update/apply"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["system", "update-check"] });
    },
  });
}

// Last thing the updater reported. After a failed update the backend may have
// been restarted (rolled back) underneath the page, so the page reads this on
// load to show "rolled back" instead of silently showing the old version.
export function useUpdateProgress(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["system", "update-progress"],
    queryFn: () => api.get<UpdateProgress>("/system/update/progress"),
    staleTime: 30 * 1000,
  });
}
