"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n/context";

export const RECEIPT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  email: string;
  consent: boolean;
  onEmail: (value: string) => void;
  onConsent: (value: boolean) => void;
}

/** Optional receipt email at checkout: the address is used only with consent. */
export function ReceiptEmailField({ email, consent, onEmail, onConsent }: Props) {
  const { t } = useI18n();
  const invalid = consent && email.trim() !== "" && !RECEIPT_EMAIL_PATTERN.test(email.trim());
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="receipt-email-field">
      <Label htmlFor="receipt-email">{t("pos.checkout.receiptEmail.label")}</Label>
      <Input
        id="receipt-email"
        type="email"
        inputMode="email"
        autoComplete="off"
        value={email}
        onChange={(e) => onEmail(e.target.value)}
        placeholder={t("pos.checkout.receiptEmail.placeholder")}
        aria-invalid={invalid}
        className="h-11"
      />
      <label className="flex min-h-11 items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={consent}
          onChange={(e) => onConsent(e.target.checked)}
        />
        {t("pos.checkout.receiptEmail.consent")}
      </label>
      {invalid && <p className="text-xs text-destructive">{t("pos.checkout.receiptEmail.invalid")}</p>}
    </div>
  );
}
