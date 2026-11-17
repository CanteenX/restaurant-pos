"use client";

import { ImagePlus, X } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { toast } from "@/lib/toast";
import {
  RESTAURANT_NAME_MAX_LENGTH,
  TAX_REGIME_PRESETS,
  TAX_REGIMES,
  type TaxMode,
  type TaxRegime,
} from "@nventra/types";
import { KioskCard } from "@/components/settings/kiosk-card";
import { MobileAppCard } from "@/components/settings/mobile-app-card";
import { PrinterDiagnosticsCard } from "@/components/settings/printer-diagnostics-card";
import { BluetoothPrinterCard } from "@/components/settings/bluetooth-printer-card";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusNote, useNoteToast } from "@/components/ui/status-note";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useBranch } from "@/hooks/use-branch";
import { useNotificationMute } from "@/hooks/use-notification-mute";
import {
  useSettings,
  useUpdateBranchSettings,
  useUpdateRestaurantSettings,
  useUploadRestaurantLogo,
  type BranchSettings,
  type RestaurantSettings,
} from "@/hooks/use-settings";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

// Inline markup helper for translated strings.
function rich(text: string, tags: Record<string, (children: string) => ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
    const at = m.index ?? 0;
    out.push(text.slice(last, at));
    out.push(<Fragment key={at}>{tags[m[1]]?.(m[2]) ?? m[2]}</Fragment>);
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export default function SettingsPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const { data, isLoading } = useSettings(branchId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.general.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.general.subtitle")}</p>
      </div>

      <SettingsTabs />

      {isLoading || !data ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : (
        <GeneralSettingsForm
          key={`${data.restaurant.id}-${data.branch.id}`}
          restaurant={data.restaurant}
          branch={data.branch}
          branchId={branchId}
        />
      )}

      {data && <OnlineOrdersCard key={data.branch.id} branchId={branchId} branch={data.branch} />}

      {data && <KioskCard key={`kiosk-${data.branch.id}`} branchId={branchId} branch={data.branch} />}

      <NotificationSettingsCard />

      <BluetoothPrinterCard />
      <PrinterDiagnosticsCard />
      <MobileAppCard />
    </div>
  );
}

function OnlineOrdersCard({
  branchId,
  branch,
}: {
  branchId: string | null;
  branch: { autoConfirmOrders: boolean; autoConfirmReservations: boolean };
}) {
  const { t } = useI18n();
  const update = useUpdateBranchSettings(branchId);
  const save = (dto: { autoConfirmOrders?: boolean; autoConfirmReservations?: boolean }) =>
    update.mutate(dto, {
      onSuccess: () => toast.success(t("settings.general.saved")),
      onError: (err) => toast.error(err instanceof Error ? err.message : t("settings.general.saveFailed")),
    });

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-[18px] font-medium text-foreground">{t("settings.general.online.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.general.online.desc")}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="auto-confirm-orders">{t("settings.general.online.autoOrders.label")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.general.online.autoOrders.help")}
          </p>
        </div>
        <Switch
          id="auto-confirm-orders"
          checked={branch.autoConfirmOrders}
          disabled={update.isPending}
          onCheckedChange={(v) => save({ autoConfirmOrders: v })}
        />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="auto-confirm-bookings">{t("settings.general.online.autoBookings.label")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.general.online.autoBookings.help")}
          </p>
        </div>
        <Switch
          id="auto-confirm-bookings"
          checked={branch.autoConfirmReservations}
          disabled={update.isPending}
          onCheckedChange={(v) => save({ autoConfirmReservations: v })}
        />
      </div>
    </Card>
  );
}

function NotificationSettingsCard() {
  const { t } = useI18n();
  const [muted, toggleMuted] = useNotificationMute();

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-[18px] font-medium text-foreground">{t("settings.general.notifications.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.general.notifications.desc")}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="notification-sound">{t("settings.general.notifications.sound.label")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.general.notifications.sound.help")}
          </p>
        </div>
        <Switch
          id="notification-sound"
          checked={!muted}
          onCheckedChange={() => toggleMuted()}
        />
      </div>
    </Card>
  );
}

function GeneralSettingsForm({
  restaurant,
  branch,
  branchId,
}: {
  restaurant: RestaurantSettings;
  branch: BranchSettings;
  branchId: string | null;
}) {
  const [name, setName] = useState(restaurant.name);
  const [legalName, setLegalName] = useState(restaurant.legalName ?? "");
  const [logoUrl, setLogoUrl] = useState<string | null>(restaurant.logoUrl);
  const [currency, setCurrency] = useState(restaurant.currency);
  const [timezone, setTimezone] = useState(restaurant.timezone);
  const [upiVpa, setUpiVpa] = useState(restaurant.upiVpa ?? "");
  const [upiPayeeName, setUpiPayeeName] = useState(restaurant.upiPayeeName ?? "");
  const [loyaltyPointValue, setLoyaltyPointValue] = useState(restaurant.loyaltyPointValue);
  const [loyaltyEarnPerCurrency, setLoyaltyEarnPerCurrency] = useState(
    String(restaurant.loyaltyEarnPerCurrency),
  );
  const [referralEnabled, setReferralEnabled] = useState(!!restaurant.referralEnabled);
  const [referralSharerPoints, setReferralSharerPoints] = useState(String(restaurant.referralSharerPoints ?? 15));
  const [referralReferredPoints, setReferralReferredPoints] = useState(String(restaurant.referralReferredPoints ?? 10));
  const [referralMinPurchase, setReferralMinPurchase] = useState(String(Number(restaurant.referralMinPurchase ?? 200)));
  const [onlineMinOrder, setOnlineMinOrder] = useState(String(Number(restaurant.onlineMinOrderAmount ?? 0)));
  const initialAdjust = Number(restaurant.onlinePriceAdjustValue ?? 0);
  const [adjustKind, setAdjustKind] = useState<"PERCENT" | "AMOUNT">(restaurant.onlinePriceAdjustKind ?? "PERCENT");
  const [adjustDir, setAdjustDir] = useState<"cheaper" | "costlier">(initialAdjust < 0 ? "cheaper" : "costlier");
  const [adjustValue, setAdjustValue] = useState(String(Math.abs(initialAdjust)));
  const [maxDiscount, setMaxDiscount] = useState(String(Number(restaurant.maxManualDiscountPercent ?? 100)));
  const [requireReason, setRequireReason] = useState(!!restaurant.requireDiscountReason);
  const [digitalReceipts, setDigitalReceipts] = useState(!!restaurant.digitalReceiptsEnabled);
  const { t } = useI18n();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const uploadLogo = useUploadRestaurantLogo();

  const [branchName, setBranchName] = useState(branch.name);
  const [address, setAddress] = useState(branch.address ?? "");
  const [phone, setPhone] = useState(branch.phone ?? "");
  const [gstNumber, setGstNumber] = useState(branch.gstNumber ?? "");
  const [country, setCountry] = useState(branch.country);
  const [taxRegime, setTaxRegime] = useState<TaxRegime>(branch.taxRegime);
  const [taxMode, setTaxMode] = useState<TaxMode>(branch.taxMode);
  const [taxLabel, setTaxLabel] = useState(branch.taxLabel ?? "");
  const [taxId, setTaxId] = useState(branch.taxId ?? "");

  const preset = TAX_REGIME_PRESETS[taxRegime];

  const updateRestaurant = useUpdateRestaurantSettings(branchId);
  const { note: saveNote, clear: clearSaveNote, toast: saveToast } = useNoteToast();
  const updateBranch = useUpdateBranchSettings(branchId);

  const onSubmitRestaurant = (e: React.FormEvent) => {
    e.preventDefault();
    updateRestaurant.mutate(
      {
        name,
        legalName: legalName || undefined,
        logoUrl,
        currency,
        timezone,
        upiVpa: upiVpa.trim() || null,
        upiPayeeName: upiPayeeName.trim() || null,
        loyaltyPointValue: Number(loyaltyPointValue) || 0,
        loyaltyEarnPerCurrency: Number(loyaltyEarnPerCurrency) || 1,
        referralEnabled,
        referralSharerPoints: Math.max(Math.floor(Number(referralSharerPoints) || 0), 0),
        referralReferredPoints: Math.max(Math.floor(Number(referralReferredPoints) || 0), 0),
        referralMinPurchase: Math.max(Number(referralMinPurchase) || 0, 0),
        onlineMinOrderAmount: Math.max(Number(onlineMinOrder) || 0, 0),
        onlinePriceAdjustKind: adjustKind,
        onlinePriceAdjustValue: (adjustDir === "cheaper" ? -1 : 1) * Math.abs(Number(adjustValue) || 0),
        maxManualDiscountPercent: Math.min(Math.max(Number(maxDiscount) || 0, 0), 100),
        requireDiscountReason: requireReason,
        digitalReceiptsEnabled: digitalReceipts,
      },
      {
        onSuccess: () => saveToast.success(t("settings.general.restaurantSaved")),
        onError: (err) => saveToast.error(err instanceof ApiError ? err.message : t("settings.general.saveFailed")),
      },
    );
  };

  const onSubmitBranch = (e: React.FormEvent) => {
    e.preventDefault();
    updateBranch.mutate(
      {
        name: branchName,
        address: address || undefined,
        phone: phone || undefined,
        gstNumber: gstNumber || undefined,
        country,
        taxRegime,
        taxMode,
        taxLabel: taxLabel || null,
        taxId: taxId || null,
      },
      {
        onSuccess: () => toast.success(t("settings.general.branch.saved")),
        onError: (err) => toast.error(err instanceof ApiError ? err.message : t("settings.general.saveFailed")),
      },
    );
  };

  const onRegimeChange = (value: TaxRegime | null) => {
    if (!value) return;
    setTaxRegime(value);
    // Switching regimes resets to that regime's own mode/country by
    // default — a picker that silently kept the old mode would quietly
    // mis-price every item on this branch (see settings.service.ts).
    setTaxMode(TAX_REGIME_PRESETS[value].defaultMode);
    setCountry(TAX_REGIME_PRESETS[value].defaultCountry);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="flex flex-col gap-4 p-6">
        <h2 className="text-[18px] font-medium text-foreground">{t("settings.general.restaurant.title")}</h2>
        <form onSubmit={onSubmitRestaurant} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>{t("settings.general.logo.label")}</Label>
            <div className="flex items-center gap-4">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  uploadLogo.mutate(file, {
                    onSuccess: (res) => setLogoUrl(res.url),
                    onError: (err) =>
                      toast.error(err instanceof ApiError ? err.message : t("settings.general.logo.uploadFailed")),
                  });
                }}
              />
              {logoUrl ? (
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-secondary">
                  {/* eslint-disable-next-line @next/next/no-img-element -- uploaded asset served from the backend, not a Next-optimizable remote source */}
                  <img src={logoUrl} alt="" className="h-full w-full object-contain" />
                  <button
                    type="button"
                    onClick={() => {
                      setLogoUrl(null);
                      if (logoInputRef.current) logoInputRef.current.value = "";
                    }}
                    className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-foreground"
                    aria-label={t("settings.general.logo.remove")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  disabled={uploadLogo.isPending}
                  className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary"
                >
                  <ImagePlus className="h-4 w-4" />
                  <span className="text-[10px]">
                    {uploadLogo.isPending ? t("settings.general.logo.uploading") : t("settings.general.logo.upload")}
                  </span>
                </button>
              )}
              <p className="text-xs text-muted-foreground">
                {t("settings.general.logo.help")}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="r-name">{t("settings.general.name")}</Label>
            <Input
              id="r-name"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, RESTAURANT_NAME_MAX_LENGTH))}
              maxLength={RESTAURANT_NAME_MAX_LENGTH}
              required
            />
            <p className="text-right text-xs text-muted-foreground">
              {name.length}/{RESTAURANT_NAME_MAX_LENGTH}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="r-legal">{t("settings.general.legalName")}</Label>
            <Input id="r-legal" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-currency">{t("settings.general.currency")}</Label>
              <Input
                id="r-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                maxLength={3}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-timezone">{t("settings.general.timezone")}</Label>
              <Input id="r-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-medium text-foreground">{t("settings.general.loyalty.title")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("settings.general.loyalty.desc")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-loyalty-earn">{t("settings.general.loyalty.earn")}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{currency}</span>
                <Input
                  id="r-loyalty-earn"
                  type="number"
                  min="1"
                  step="1"
                  value={loyaltyEarnPerCurrency}
                  onChange={(e) => setLoyaltyEarnPerCurrency(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-loyalty-value">{t("settings.general.loyalty.redeem")}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{currency}</span>
                <Input
                  id="r-loyalty-value"
                  type="number"
                  min="0"
                  step="0.01"
                  value={loyaltyPointValue}
                  onChange={(e) => setLoyaltyPointValue(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t("settings.general.referral.title")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("settings.general.referral.desc", { currency })}
                </p>
              </div>
              <Switch
                id="r-referral-enabled"
                aria-label={t("settings.general.referral.enable")}
                checked={referralEnabled}
                onCheckedChange={setReferralEnabled}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="r-referral-sharer">{t("settings.general.referral.sharer")}</Label>
                <Input
                  id="r-referral-sharer"
                  type="number"
                  min="0"
                  step="1"
                  disabled={!referralEnabled}
                  value={referralSharerPoints}
                  onChange={(e) => setReferralSharerPoints(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="r-referral-referred">{t("settings.general.referral.referred")}</Label>
                <Input
                  id="r-referral-referred"
                  type="number"
                  min="0"
                  step="1"
                  disabled={!referralEnabled}
                  value={referralReferredPoints}
                  onChange={(e) => setReferralReferredPoints(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-referral-min">{t("settings.general.referral.min", { currency })}</Label>
              <Input
                id="r-referral-min"
                type="number"
                min="0"
                step="1"
                disabled={!referralEnabled}
                value={referralMinPurchase}
                onChange={(e) => setReferralMinPurchase(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">{t("settings.general.web.title")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("settings.general.web.desc")}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="r-adjust-dir">{t("settings.general.web.makePrices")}</Label>
                <select
                  id="r-adjust-dir"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={adjustDir}
                  onChange={(e) => setAdjustDir(e.target.value as "cheaper" | "costlier")}
                >
                  <option value="cheaper">{t("settings.general.web.cheaper")}</option>
                  <option value="costlier">{t("settings.general.web.costlier")}</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="r-adjust-kind">{t("settings.general.web.by")}</Label>
                <select
                  id="r-adjust-kind"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={adjustKind}
                  onChange={(e) => setAdjustKind(e.target.value as "PERCENT" | "AMOUNT")}
                >
                  <option value="PERCENT">{t("settings.general.web.percentOption")}</option>
                  <option value="AMOUNT">{t("settings.general.web.amountOption", { currency })}</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="r-adjust-value">{adjustKind === "PERCENT" ? t("settings.general.web.percentLabel") : t("settings.general.web.amountLabel", { currency })}</Label>
                <Input
                  id="r-adjust-value"
                  type="number"
                  min="0"
                  step="0.01"
                  value={adjustValue}
                  onChange={(e) => setAdjustValue(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {Number(adjustValue) > 0
                ? t("settings.general.web.example", {
                    currency,
                    price: Math.max(
                      Math.round(
                        (adjustKind === "PERCENT"
                          ? 100 * (1 + ((adjustDir === "cheaper" ? -1 : 1) * Number(adjustValue)) / 100)
                          : 100 + (adjustDir === "cheaper" ? -1 : 1) * Number(adjustValue)) * 100,
                      ) / 100,
                      0,
                    ),
                  })
                : t("settings.general.web.noChange")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="r-online-min">{t("settings.general.onlineMin.label", { currency })}</Label>
            <Input
              id="r-online-min"
              type="number"
              min="0"
              step="1"
              value={onlineMinOrder}
              onChange={(e) => setOnlineMinOrder(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.general.onlineMin.help")}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-max-discount">{t("settings.general.discount.max")}</Label>
              <Input
                id="r-max-discount"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={maxDiscount}
                onChange={(e) => setMaxDiscount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.general.discount.maxHelp")}
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm sm:pt-7">
              <input
                type="checkbox"
                className="mt-1"
                checked={requireReason}
                onChange={(e) => setRequireReason(e.target.checked)}
              />
              {t("settings.general.discount.requireReason")}
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex min-h-11 items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={digitalReceipts}
                onChange={(e) => setDigitalReceipts(e.target.checked)}
              />
              {t("settings.general.digitalReceipts.label")}
            </label>
            <p className="text-xs text-muted-foreground">{t("settings.general.digitalReceipts.hint")}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-upi">{t("settings.general.upi.label")}</Label>
              <Input
                id="r-upi"
                value={upiVpa}
                onChange={(e) => setUpiVpa(e.target.value)}
                placeholder={t("settings.general.upi.placeholder")}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.general.upi.help")}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-upi-name">{t("settings.general.upi.payeeName")}</Label>
              <Input
                id="r-upi-name"
                value={upiPayeeName}
                onChange={(e) => setUpiPayeeName(e.target.value)}
                placeholder={name}
                maxLength={60}
              />
            </div>
          </div>

          <StatusNote note={saveNote} onClear={clearSaveNote} />
          <Button type="submit" disabled={updateRestaurant.isPending} className="self-start">
            {updateRestaurant.isPending ? t("settings.general.saving") : t("settings.general.saveRestaurant")}
          </Button>
        </form>
      </Card>

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="text-[18px] font-medium text-foreground">{t("settings.general.branch.title")}</h2>
        <form onSubmit={onSubmitBranch} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="b-name">{t("settings.general.branch.name")}</Label>
            <Input id="b-name" value={branchName} onChange={(e) => setBranchName(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="b-address">{t("settings.general.branch.address")}</Label>
            <Input id="b-address" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="b-phone">{t("settings.general.branch.phone")}</Label>
              <Input id="b-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="b-gst">{t("settings.general.branch.gst")}</Label>
              <Input id="b-gst" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-medium text-foreground">{t("settings.general.tax.title")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("settings.general.tax.desc")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="b-tax-regime">{t("settings.general.tax.regime")}</Label>
              <Select value={taxRegime} onValueChange={onRegimeChange}>
                <SelectTrigger id="b-tax-regime">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TAX_REGIMES.map((regime) => (
                    <SelectItem key={regime} value={regime}>
                      {TAX_REGIME_PRESETS[regime].displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="b-tax-mode">{t("settings.general.tax.menuPrices")}</Label>
              <Select value={taxMode} onValueChange={(v) => setTaxMode(v as TaxMode)}>
                <SelectTrigger id="b-tax-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INCLUSIVE">{t("settings.general.tax.inclusive")}</SelectItem>
                  <SelectItem value="EXCLUSIVE">{t("settings.general.tax.exclusive")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.general.tax.examples", { rates: preset.exampleRates })}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="b-country">{t("settings.general.tax.country")}</Label>
              <Input
                id="b-country"
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                maxLength={2}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="b-tax-id">{TAX_REGIME_PRESETS[taxRegime].taxIdLabel}</Label>
              <Input id="b-tax-id" value={taxId} onChange={(e) => setTaxId(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="b-tax-label">{t("settings.general.tax.labelOverride")}</Label>
            <Input
              id="b-tax-label"
              value={taxLabel}
              onChange={(e) => setTaxLabel(e.target.value)}
              placeholder={preset.taxLabel}
            />
          </div>

          <Button type="submit" disabled={updateBranch.isPending} className="self-start">
            {updateBranch.isPending ? t("settings.general.saving") : t("settings.general.branch.save")}
          </Button>
        </form>
      </Card>

      <p className="text-xs text-muted-foreground">
        {rich(t("settings.general.license"), {
          repo: (text) => (
            <a
              className="underline"
              href="https://github.com/CanteenX/restaurant-pos"
              target="_blank"
              rel="noopener noreferrer"
            >
              {text}
            </a>
          ),
          upstream: (text) => (
            <a
              className="underline"
              href="https://github.com/Raktim94/nodedr-restaurant-pos"
              target="_blank"
              rel="noopener noreferrer"
            >
              {text}
            </a>
          ),
        })}
      </p>
    </div>
  );
}
