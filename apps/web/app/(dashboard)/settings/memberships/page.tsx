"use client";

import { useI18n } from "@/lib/i18n/context";
import { useState } from "react";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useCreateTier,
  useMembershipTiers,
  useUpdateTier,
  type MembershipTier,
} from "@/hooks/use-memberships";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function NewTierForm() {
  const { t } = useI18n();
  const create = useCreateTier();
  const [name, setName] = useState("");
  const [rank, setRank] = useState("1");
  const [discount, setDiscount] = useState("0");
  const [multiplier, setMultiplier] = useState("1");
  const [days, setDays] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name,
        rank: Number(rank),
        discountPercent: Number(discount),
        pointsMultiplier: Number(multiplier),
        durationDays: days ? Number(days) : null,
        active: true,
      },
      {
        onSuccess: () => {
          toast.success(t("settings.memberships.tierAdded"));
          setName("");
        },
        onError: (err) => toast.error(errMsg(err, t("settings.memberships.error"))),
      },
    );
  };

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <div className="col-span-2 flex flex-col gap-1">
          <Label htmlFor="tier-name">{t("settings.memberships.tierName")}</Label>
          <Input id="tier-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-rank">{t("settings.memberships.rank")}</Label>
          <Input id="tier-rank" type="number" min={0} value={rank} onChange={(e) => setRank(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-discount">{t("settings.memberships.discount")}</Label>
          <Input id="tier-discount" type="number" min={0} max={100} step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-mult">{t("settings.memberships.pointsMultiplier")}</Label>
          <Input id="tier-mult" type="number" min={1} max={10} step="0.01" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-days">{t("settings.memberships.days")}</Label>
          <Input id="tier-days" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <Button type="submit" className="col-span-2 sm:col-span-1" disabled={create.isPending || !name.trim()}>
          {t("settings.memberships.addTier")}
        </Button>
      </form>
    </Card>
  );
}

function TierRow({ tier }: { tier: MembershipTier }) {
  const { t } = useI18n();
  const update = useUpdateTier();
  return (
    <li data-testid="tier-row" className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div className="flex flex-col">
        <span className="font-medium text-foreground">{tier.name}</span>
        <span className="text-xs text-muted-foreground">
          {t("settings.memberships.summary", {
            rank: tier.rank,
            discount: Number(tier.discountPercent),
            multiplier: Number(tier.pointsMultiplier),
            duration: tier.durationDays
              ? t("settings.memberships.durationDays", { days: tier.durationDays })
              : t("settings.memberships.noExpiry"),
          })}
        </span>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {t("settings.memberships.active")}
        <Switch
          checked={tier.active}
          disabled={update.isPending}
          onCheckedChange={(active) =>
            update.mutate({ id: tier.id, dto: { active } }, { onError: (err) => toast.error(errMsg(err, t("settings.memberships.error"))) })
          }
        />
      </label>
    </li>
  );
}

export default function MembershipsSettingsPage() {
  const { t } = useI18n();
  const { data, isLoading } = useMembershipTiers();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.memberships.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.memberships.subtitle")}</p>
      </div>
      <SettingsTabs />
      <NewTierForm />
      <Card className="p-5">
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : data && data.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {data.map((t) => (
              <TierRow key={t.id} tier={t} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.memberships.empty")}</p>
        )}
      </Card>
    </div>
  );
}
