"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EmailTemplateUpdateDto, EmailTemplateView } from "@nventra/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useEmailPreview, useEmailTemplateActions, useEmailTestRecipient } from "@/hooks/use-email-templates";
import { ApiError } from "@/lib/api";
import {
  draftFromView,
  insertPlaceholder,
  isDraftDirty,
  sendTestErrorKind,
  validateDraft,
  type DraftField,
  type TemplateDraft,
} from "@/lib/email-template-form";
import { useI18n } from "@/lib/i18n/context";
import { PreviewPane } from "./preview-pane";
import { PlaceholderChips, TemplateField, useDraftErrorText, type FieldElement } from "./template-fields";

const PREVIEW_DEBOUNCE_MS = 400;

export type Notify = (kind: "success" | "error", text: string) => void;

interface TemplateEditorProps {
  view: EmailTemplateView;
  name: string;
  notify: Notify;
  onDirtyChange: (dirty: boolean) => void;
}

/** Mounted per template version (keyed by the parent), so the draft starts from the saved values. */
export function TemplateEditor({ view, name, notify, onDirtyChange }: TemplateEditorProps) {
  const { t } = useI18n();
  const errorText = useDraftErrorText();
  const { save, reset, sendTest } = useEmailTemplateActions();
  const recipient = useEmailTestRecipient().data;
  const [draft, setDraft] = useState<TemplateDraft>(() => draftFromView(view));
  const [confirmReset, setConfirmReset] = useState(false);
  const lastField = useRef<DraftField>("body");
  const fields = useRef<Partial<Record<DraftField, FieldElement | null>>>({});

  const validation = useMemo(() => validateDraft(view.key, draft), [view.key, draft]);
  const errors = validation.ok ? {} : validation.errors;
  const dirty = isDraftDirty(view, draft);
  const [previewDraft, setPreviewDraft] = useState<EmailTemplateUpdateDto | null>(() =>
    validation.ok ? validation.dto : null,
  );
  const preview = useEmailPreview(view.key, previewDraft);

  useEffect(() => {
    if (!validation.ok) return;
    const dto = validation.dto;
    const timer = setTimeout(() => setPreviewDraft(dto), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [validation]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const setField = (field: DraftField, value: string) => setDraft((d) => ({ ...d, [field]: value }));

  const insert = (placeholder: string) => {
    const field = lastField.current;
    const el = fields.current[field];
    const current = draft[field];
    const result = insertPlaceholder(
      current,
      el?.selectionStart ?? current.length,
      el?.selectionEnd ?? current.length,
      placeholder,
      view.placeholders,
    );
    if (!result) return;
    setField(field, result.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(result.caret, result.caret);
    });
  };

  const onSave = () => {
    if (!validation.ok) return;
    // mutateAsync, not mutate(.., {onSuccess}): the refetch re-keys (unmounts) this
    // editor, and per-call callbacks are dropped once the component is gone.
    save
      .mutateAsync({ key: view.key, dto: validation.dto })
      .then(() => notify("success", t("settings.emailTemplates.actions.saved")))
      .catch(() => notify("error", t("settings.emailTemplates.actions.saveError")));
  };

  const onReset = () =>
    reset
      .mutateAsync(view.key)
      .then(() => {
        setConfirmReset(false);
        notify("success", t("settings.emailTemplates.reset.done"));
      })
      .catch(() => notify("error", t("settings.emailTemplates.reset.error")));

  const onSendTest = () => {
    if (!validation.ok || !recipient?.email) return;
    const email = recipient.email;
    sendTest.mutate(
      { key: view.key, draft: validation.dto },
      {
        onSuccess: () => notify("success", t("settings.emailTemplates.test.sent", { email })),
        onError: (e) => {
          const kind = e instanceof ApiError ? sendTestErrorKind(e.status, e.message) : "failed";
          notify("error", t(`settings.emailTemplates.test.${kind}`));
        },
      },
    );
  };

  const field = (f: DraftField, opts: { multiline?: boolean; hint?: string } = {}) => (
    <TemplateField
      field={f}
      value={draft[f]}
      error={errorText(errors[f])}
      hint={opts.hint}
      multiline={opts.multiline}
      inputRef={(el) => {
        fields.current[f] = el;
      }}
      onChange={(v) => setField(f, v)}
      onFocus={() => {
        lastField.current = f;
      }}
    />
  );

  const testHint = !recipient
    ? null
    : !recipient.configured
      ? t("settings.emailTemplates.test.notConfigured")
      : recipient.email
        ? t("settings.emailTemplates.test.to", { email: recipient.email })
        : t("settings.emailTemplates.test.noEmail");

  return (
    <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,640px)]">
      <Card className="flex min-w-0 flex-col gap-4 p-4 sm:p-6" data-testid="email-template-editor">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 break-words text-lg font-semibold text-foreground">
            {t("settings.emailTemplates.editor.title", { name })}
          </h2>
          {dirty && <Badge variant="secondary">{t("settings.emailTemplates.editor.unsaved")}</Badge>}
        </div>

        <label className="flex items-center gap-3 text-sm font-medium text-foreground">
          <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} />
          {t("settings.emailTemplates.field.enabled")}
        </label>
        {!draft.enabled && <p className="text-xs text-muted-foreground">{t("settings.emailTemplates.editor.off")}</p>}

        {field("subject")}
        {field("heading")}
        {field("body", { multiline: true, hint: t("settings.emailTemplates.field.bodyHint") })}
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          {field("buttonText", { hint: t("settings.emailTemplates.field.buttonHint") })}
          {field("buttonUrl")}
        </div>
        {field("footer", { multiline: true })}

        <PlaceholderChips names={view.placeholders} onInsert={insert} />

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={onSave} disabled={!dirty || !validation.ok || save.isPending}>
              {save.isPending ? t("settings.emailTemplates.actions.saving") : t("settings.emailTemplates.actions.save")}
            </Button>
            <Button variant="outline" onClick={() => setConfirmReset(true)} disabled={!view.isCustom || reset.isPending}>
              {t("settings.emailTemplates.actions.reset")}
            </Button>
            <Button
              variant="outline"
              onClick={onSendTest}
              disabled={!validation.ok || !recipient?.email || !recipient.configured || sendTest.isPending}
            >
              {t("settings.emailTemplates.test.button")}
            </Button>
          </div>
          {testHint && (
            <p data-testid="email-test-recipient" className="break-words text-xs text-muted-foreground">
              {testHint}
            </p>
          )}
        </div>
      </Card>

      <Card className="min-w-0 p-4 sm:p-6">
        <PreviewPane
          preview={preview.data}
          isLoading={preview.isFetching}
          isError={preview.isError}
          stale={!validation.ok}
        />
      </Card>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.emailTemplates.reset.title")}</DialogTitle>
            <DialogDescription>{t("settings.emailTemplates.reset.desc", { name })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              {t("settings.emailTemplates.reset.cancel")}
            </Button>
            <Button variant="destructive" onClick={onReset} disabled={reset.isPending}>
              {t("settings.emailTemplates.reset.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
