"use client";

import { useState, type SyntheticEvent } from "react";
import type { EmailPreviewView } from "@nventra/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n/context";
import { PREVIEW_WIDTHS, type PreviewDevice } from "@/lib/email-template-form";
import { cn } from "@/lib/utils";

type PreviewFormat = "html" | "text";

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Grows the iframe to its content. Scripts never run (no allow-scripts). */
function fitHeight(e: SyntheticEvent<HTMLIFrameElement>) {
  const doc = e.currentTarget.contentDocument;
  if (doc?.documentElement) e.currentTarget.style.height = `${doc.documentElement.scrollHeight + 4}px`;
}

interface PreviewPaneProps {
  preview: EmailPreviewView | undefined;
  isLoading: boolean;
  isError: boolean;
  /** True while the draft has errors and the preview shows the last valid one. */
  stale: boolean;
}

export function PreviewPane({ preview, isLoading, isError, stale }: PreviewPaneProps) {
  const { t } = useI18n();
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [format, setFormat] = useState<PreviewFormat>("html");

  return (
    <section aria-labelledby="email-preview-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="email-preview-title" className="text-base font-semibold text-foreground">
          {t("settings.emailTemplates.preview.title")}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Segmented
            label={t("settings.emailTemplates.preview.device")}
            value={device}
            onChange={setDevice}
            options={[
              { value: "desktop", label: t("settings.emailTemplates.preview.desktop") },
              { value: "mobile", label: t("settings.emailTemplates.preview.mobile") },
            ]}
          />
          <Segmented
            label={t("settings.emailTemplates.preview.format")}
            value={format}
            onChange={setFormat}
            options={[
              { value: "html", label: t("settings.emailTemplates.preview.html") },
              { value: "text", label: t("settings.emailTemplates.preview.text") },
            ]}
          />
        </div>
      </div>

      {stale && <p className="text-xs text-warning">{t("settings.emailTemplates.preview.invalid")}</p>}
      {isError && <p className="text-xs text-destructive">{t("settings.emailTemplates.preview.error")}</p>}

      {preview ? (
        <>
          <p data-testid="email-preview-subject" className="break-words text-sm text-foreground">
            {t("settings.emailTemplates.preview.subject", { subject: preview.subject })}
          </p>
          {/* Scrolls on its own so a 600px preview never widens the page. */}
          <div className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-2">
            {format === "html" ? (
              <iframe
                key={device}
                title={t("settings.emailTemplates.preview.frame")}
                data-testid="email-preview-frame"
                // Same origin only so the height can be measured; no scripts, forms or popups.
                sandbox="allow-same-origin"
                srcDoc={preview.html}
                onLoad={fitHeight}
                style={{ width: PREVIEW_WIDTHS[device] }}
                className="mx-auto block min-h-64 max-w-none rounded bg-white"
              />
            ) : (
              <pre
                data-testid="email-preview-text"
                style={{ maxWidth: PREVIEW_WIDTHS[device] }}
                className="mx-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono text-xs text-foreground"
              >
                {preview.text}
              </pre>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {isLoading ? t("settings.emailTemplates.preview.loading") : t("settings.emailTemplates.preview.sample")}
          </p>
        </>
      ) : isLoading ? (
        <Skeleton className="h-64" />
      ) : null}
    </section>
  );
}
