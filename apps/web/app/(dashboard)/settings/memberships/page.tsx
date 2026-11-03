"use client";

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

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong");

function NewTierForm() {
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
          toast.success("Tier added");
          setName("");
        },
        onError: (err) => toast.error(errMsg(err)),
      },
    );
  };

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <div className="col-span-2 flex flex-col gap-1">
          <Label htmlFor="tier-name">Tier name</Label>
          <Input id="tier-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-rank">Rank</Label>
          <Input id="tier-rank" type="number" min={0} value={rank} onChange={(e) => setRank(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-discount">Discount %</Label>
          <Input id="tier-discount" type="number" min={0} max={100} step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-mult">Points ×</Label>
          <Input id="tier-mult" type="number" min={1} max={10} step="0.01" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tier-days">Days (blank = no expiry)</Label>
          <Input id="tier-days" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <Button type="submit" className="col-span-2 sm:col-span-1" disabled={create.isPending || !name.trim()}>
          Add tier
        </Button>
      </form>
    </Card>
  );
}

function TierRow({ tier }: { tier: MembershipTier }) {
  const update = useUpdateTier();
  return (
    <li data-testid="tier-row" className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div className="flex flex-col">
        <span className="font-medium text-foreground">{tier.name}</span>
        <span className="text-xs text-muted-foreground">
          Rank {tier.rank} · {Number(tier.discountPercent)}% off · {Number(tier.pointsMultiplier)}× points ·{" "}
          {tier.durationDays ? `${tier.durationDays} days` : "no expiry"}
        </span>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Active
        <Switch
          checked={tier.active}
          disabled={update.isPending}
          onCheckedChange={(active) =>
            update.mutate({ id: tier.id, dto: { active } }, { onError: (err) => toast.error(errMsg(err)) })
          }
        />
      </label>
    </li>
  );
}

export default function MembershipsSettingsPage() {
  const { data, isLoading } = useMembershipTiers();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">Membership tiers and their benefits</p>
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
          <p className="text-sm text-muted-foreground">No tiers yet. Add one above.</p>
        )}
      </Card>
    </div>
  );
}
