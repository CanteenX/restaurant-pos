"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranch } from "@/hooks/use-branch";
import {
  useDeliveries,
  useDeliveryActions,
  useDrivers,
  useZoneActions,
  useZones,
  type DeliveryOrder,
  type DeliveryStatus,
} from "@/hooks/use-delivery";
import { ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

type Translate = ReturnType<typeof useI18n>["t"];

const DeliveryMap = dynamic(() => import("@/components/delivery/delivery-map"), {
  ssr: false,
  loading: () => <Skeleton className="h-80" />,
});

const STATUS_LABEL: Record<DeliveryStatus, TranslationKey> = {
  UNASSIGNED: "delivery.status.UNASSIGNED",
  ASSIGNED: "delivery.status.ASSIGNED",
  PICKED_UP: "delivery.status.PICKED_UP",
  DELIVERED: "delivery.status.DELIVERED",
  FAILED: "delivery.status.FAILED",
};

const TAB_LABEL = {
  active: "delivery.tab.active",
  history: "delivery.tab.history",
  zones: "delivery.tab.zones",
} as const satisfies Record<string, TranslationKey>;

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const errMsg = (e: unknown, t: Translate) => (e instanceof ApiError ? e.message : t("delivery.error"));

function DeliveryCard({ order, branchId }: { order: DeliveryOrder; branchId: string | null }) {
  const { t } = useI18n();
  const { data: drivers } = useDrivers(branchId);
  const { assign, setStatus } = useDeliveryActions(branchId);
  const status = order.deliveryStatus ?? "UNASSIGNED";
  const move = (next: DeliveryStatus) =>
    setStatus.mutate({ orderId: order.id, status: next }, { onError: (e) => toast.error(errMsg(e, t)) });

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            #{order.orderNumber} · {order.guestName ?? t("delivery.guest")}
          </p>
          <p className="text-xs text-muted-foreground">
            {order.deliveryAddress ?? t("delivery.addressInNotes")}
            {order.deliveryPincode && ` · ${order.deliveryPincode}`}
          </p>
          {order.deliveryPlace && <p className="text-xs text-foreground">{t("delivery.landmark", { place: order.deliveryPlace })}</p>}
          {order.deliveryLat != null && order.deliveryLng != null && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${order.deliveryLat},${order.deliveryLng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs text-primary underline underline-offset-2"
            >
              {t("delivery.sharedLocation")}
            </a>
          )}
          {order.deliveryFailedReason && <p className="text-xs text-destructive">{t("delivery.notDelivered", { reason: order.deliveryFailedReason })}</p>}
          {order.deliveryPhone && (
            <a href={`tel:${order.deliveryPhone}`} className="text-xs text-primary underline underline-offset-2">
              {order.deliveryPhone}
            </a>
          )}
        </div>
        <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-foreground">
          {t(STATUS_LABEL[status])}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("delivery.totalPlusFee", { total: formatCurrency(order.totalAmount), fee: formatCurrency(order.deliveryFee) })}
        {order.deliveryZone && ` · ${order.deliveryZone.name}`}
        {order.deliveryEtaAt && t("delivery.eta", { time: time(order.deliveryEtaAt) })}
        {order.scheduledFor && t("delivery.scheduled", { time: time(order.scheduledFor) })}
      </p>
      {order.notes && <p className="text-xs italic text-muted-foreground">{order.notes}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {(status === "UNASSIGNED" || status === "ASSIGNED") && (
          <select
            aria-label={t("delivery.driverAria")}
            value={order.driver?.id ?? ""}
            onChange={(e) =>
              e.target.value &&
              assign.mutate(
                { orderId: order.id, driverId: e.target.value },
                { onError: (err) => toast.error(errMsg(err, t)) },
              )
            }
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">{t("delivery.assignDriver")}</option>
            {drivers?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.riderOnline ? t("delivery.driverOnline") : t("delivery.driverOffline")} · {d.name}
                {d.activeDeliveries > 0 ? t("delivery.activeCount", { count: d.activeDeliveries }) : ""}
              </option>
            ))}
          </select>
        )}
        {status === "PICKED_UP" && order.driver && (
          <span className="text-xs text-muted-foreground">{t("delivery.driverName", { name: order.driver.name })}</span>
        )}
        {status === "ASSIGNED" && <Button size="sm" onClick={() => move("PICKED_UP")}>{t("delivery.pickedUp")}</Button>}
        {status === "PICKED_UP" && <Button size="sm" onClick={() => move("DELIVERED")}>{t("delivery.delivered")}</Button>}
        {status !== "DELIVERED" && status !== "FAILED" && (
          <Button size="sm" variant="outline" onClick={() => move("FAILED")}>
            {t("delivery.markFailed")}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ZonesTab({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data: zones, isLoading } = useZones(branchId);
  const { create, remove, update } = useZoneActions(branchId);
  const [form, setForm] = useState({ name: "", fee: "40", minOrderAmount: "0", etaMinutes: "45", pincodes: "" });

  const submit = () => {
    const pincodes = form.pincodes.split(/[\s,]+/).filter(Boolean);
    if (!form.name.trim() || pincodes.length === 0) return toast.error(t("delivery.zone.needNamePincode"));
    create.mutate(
      {
        name: form.name.trim(),
        fee: form.fee,
        minOrderAmount: form.minOrderAmount,
        etaMinutes: Number(form.etaMinutes),
        pincodes,
        isActive: true,
      },
      {
        onSuccess: () => {
          toast.success(t("delivery.zone.added"));
          setForm({ ...form, name: "", pincodes: "" });
        },
        onError: (e) => toast.error(errMsg(e, t)),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Input placeholder={t("delivery.zone.namePlaceholder")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input placeholder={t("delivery.zone.feePlaceholder")} inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} />
        <Input placeholder={t("delivery.zone.minOrderPlaceholder")} inputMode="decimal" value={form.minOrderAmount} onChange={(e) => setForm({ ...form, minOrderAmount: e.target.value })} />
        <Input placeholder={t("delivery.zone.etaPlaceholder")} inputMode="numeric" value={form.etaMinutes} onChange={(e) => setForm({ ...form, etaMinutes: e.target.value })} />
        <Input placeholder={t("delivery.zone.pincodesPlaceholder")} value={form.pincodes} onChange={(e) => setForm({ ...form, pincodes: e.target.value })} />
        <div className="sm:col-span-2 lg:col-span-5">
          <Button onClick={submit} disabled={create.isPending}>{t("delivery.zone.add")}</Button>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("delivery.zone.note")}
          </p>
        </div>
      </Card>
      <Card className="flex flex-col divide-y divide-border p-2">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : zones && zones.length > 0 ? (
          zones.map((z) => (
            <div key={z.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className={cn("font-medium", !z.isActive && "text-muted-foreground line-through")}>{z.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t("delivery.zone.info", {
                    fee: formatCurrency(z.fee),
                    min: formatCurrency(z.minOrderAmount),
                    eta: z.etaMinutes,
                    pincodes: z.pincodes.join(", "),
                  })}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => update.mutate({ id: z.id, dto: { isActive: !z.isActive } }, { onError: (e) => toast.error(errMsg(e, t)) })}
                >
                  {z.isActive ? t("delivery.zone.disable") : t("delivery.zone.enable")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => confirm(t("delivery.zone.deleteConfirm", { name: z.name })) && remove.mutate(z.id)}
                >
                  {t("delivery.zone.delete")}
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("delivery.zone.empty")}</p>
        )}
      </Card>
    </div>
  );
}

function RidersPanel({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data: drivers, dataUpdatedAt } = useDrivers(branchId);
  if (!drivers || drivers.length === 0) return null;
  const ago = (iso: string | null) => {
    if (!iso) return t("delivery.riders.noLocation");
    const m = Math.max(Math.round((dataUpdatedAt - new Date(iso).getTime()) / 60_000), 0);
    return m < 1
      ? t("delivery.riders.justNow")
      : m < 60
        ? t("delivery.riders.minAgo", { count: m })
        : t("delivery.riders.hourAgo", { count: Math.round(m / 60) });
  };
  return (
    <section aria-labelledby="riders-h" className="flex flex-col gap-2">
      <h2 id="riders-h" className="text-sm font-medium text-foreground">
        {t("delivery.riders.title", { count: drivers.filter((d) => d.riderOnline).length })}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {drivers.map((d) => (
          <li
            key={d.id}
            data-testid={`rider-${d.id}`}
            data-lat={d.riderLat ?? undefined}
            data-lng={d.riderLng ?? undefined}
            className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">
                <span className={d.riderOnline ? "text-success" : "text-muted-foreground"} aria-hidden>
                  ●
                </span>{" "}
                {d.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t("delivery.riders.activeInfo", { state: d.riderOnline ? t("delivery.riders.online") : t("delivery.riders.offline"), count: d.activeDeliveries })}
                {d.riderOnline && ` · ${ago(d.riderLocationAt)}`}
              </p>
            </div>
            {d.riderOnline && d.riderLat != null && d.riderLng != null && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${d.riderLat},${d.riderLng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-xs text-primary underline underline-offset-2"
              >
                {t("delivery.riders.map")}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LiveMap({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data: drivers } = useDrivers(branchId);
  const { data: orders } = useDeliveries(branchId, false);
  return (
    <section aria-labelledby="map-h" className="flex flex-col gap-2">
      <h2 id="map-h" className="text-sm font-medium text-foreground">
        {t("delivery.map.title")}
      </h2>
      <DeliveryMap drivers={drivers ?? []} orders={orders ?? []} />
      <p className="text-xs text-muted-foreground">
        {t("delivery.map.legend.pins")} <span className="text-[#dc2626]">{t("delivery.map.legend.needsDriver")}</span> ·{" "}
        <span className="text-[#d97706]">{t("delivery.map.legend.assigned")}</span> ·{" "}
        <span className="text-[#2563eb]">{t("delivery.map.legend.out")}</span>. {t("delivery.map.legend.note")}
      </p>
    </section>
  );
}

export default function DeliveryPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const [tab, setTab] = useState<"active" | "history" | "zones">("active");
  const { data: orders, isLoading } = useDeliveries(branchId, tab === "history");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("delivery.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("delivery.subtitle")}</p>
      </div>
      <LiveMap branchId={branchId} />
      <RidersPanel branchId={branchId} />
      <div className="flex gap-2">
        {(["active", "history", "zones"] as const).map((tb) => (
          <button
            key={tb}
            type="button"
            onClick={() => setTab(tb)}
            className={cn(
              "rounded-full border px-3.5 py-1 text-xs capitalize transition-colors",
              tab === tb ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary",
            )}
          >
            {t(TAB_LABEL[tb])}
          </button>
        ))}
      </div>
      {tab === "zones" ? (
        <ZonesTab branchId={branchId} />
      ) : isLoading ? (
        <Skeleton className="h-24" />
      ) : orders && orders.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {orders.map((o) => (
            <DeliveryCard key={o.id} order={o} branchId={branchId} />
          ))}
        </div>
      ) : (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {tab === "active" ? t("delivery.empty.active") : t("delivery.empty.history")}
        </Card>
      )}
    </div>
  );
}
