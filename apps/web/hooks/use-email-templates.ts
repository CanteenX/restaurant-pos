"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  EmailBrandingDto,
  EmailBrandingView,
  EmailPreviewView,
  EmailTemplateKey,
  EmailTemplateUpdateDto,
  EmailTemplateView,
  EmailTestRecipientView,
} from "@nventra/types";
import { api } from "@/lib/api";

const BASE = "/email-templates";
const KEY = ["email-templates"] as const;

export function useEmailTemplates() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<EmailTemplateView[]>(BASE) });
}

export function useEmailBranding() {
  return useQuery({ queryKey: [...KEY, "branding"], queryFn: () => api.get<EmailBrandingView>(`${BASE}/branding`) });
}

export function useEmailTestRecipient() {
  return useQuery({
    queryKey: [...KEY, "test-recipient"],
    queryFn: () => api.get<EmailTestRecipientView>(`${BASE}/test-recipient`),
  });
}

/**
 * Server-rendered preview of an unsaved draft. `draft` should already be
 * debounced and valid; pass null to pause (e.g. while the draft is invalid).
 */
export function useEmailPreview(key: EmailTemplateKey, draft: EmailTemplateUpdateDto | null, brandingVersion = 0) {
  return useQuery({
    queryKey: [...KEY, "preview", key, draft, brandingVersion],
    queryFn: () => api.post<EmailPreviewView>(`${BASE}/${key}/preview`, { draft }),
    enabled: draft !== null,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

export function useEmailTemplateActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    save: useMutation({
      mutationFn: (v: { key: EmailTemplateKey; dto: EmailTemplateUpdateDto }) =>
        api.put<EmailTemplateView>(`${BASE}/${v.key}`, v.dto),
      onSuccess: refresh,
    }),
    reset: useMutation({
      mutationFn: (key: EmailTemplateKey) => api.post<EmailTemplateView>(`${BASE}/${key}/reset`),
      onSuccess: refresh,
    }),
    sendTest: useMutation({
      mutationFn: (v: { key: EmailTemplateKey; draft: EmailTemplateUpdateDto }) =>
        api.post<{ sent: true }>(`${BASE}/${v.key}/test`, { draft: v.draft }),
    }),
    saveBranding: useMutation({
      mutationFn: (dto: EmailBrandingDto) => api.put<EmailBrandingView>(`${BASE}/branding`, dto),
      onSuccess: refresh,
    }),
  };
}
