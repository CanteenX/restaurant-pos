"use client";

import {
  Banknote,
  Building2,
  CreditCard,
  Gift,
  QrCode,
  Undo2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const META: Record<string, { label: TranslationKey | null; Icon: LucideIcon }> = {
  CASH: { label: "pos.pay.cash", Icon: Banknote },
  CARD: { label: "pos.pay.card", Icon: CreditCard },
  UPI: { label: null, Icon: QrCode },
  WALLET: { label: "pos.pay.wallet", Icon: Wallet },
  BANK_TRANSFER: { label: "pos.pay.bank", Icon: Building2 },
  GIFT_CARD: { label: "pos.pay.giftCard", Icon: Gift },
  STORE_CREDIT: { label: "pos.pay.storeCredit", Icon: Undo2 },
  OTHER: { label: "pos.pay.other", Icon: Wallet },
};

// One-tap payment method picker (replaces the dropdowns): big icon buttons
// that are quick to hit on a touch screen and show every choice at once.
export function PaymentMethodButtons<T extends string>({
  methods,
  value,
  onChange,
  label,
}: {
  methods: readonly T[];
  value: T;
  onChange: (m: T) => void;
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn("grid gap-2", methods.length > 4 ? "grid-cols-3" : "grid-cols-4")}
      role="radiogroup"
      aria-label={label ?? t("pos.checkout.paymentMethod")}
    >
      {methods.map((m) => {
        const meta = META[m] ?? { label: null, Icon: Wallet };
        const { Icon } = meta;
        const text = meta.label ? t(meta.label) : m;
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-medium transition-colors",
              active
                ? "border-primary bg-primary/10 text-foreground shadow-sm"
                : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
            {text}
          </button>
        );
      })}
    </div>
  );
}
