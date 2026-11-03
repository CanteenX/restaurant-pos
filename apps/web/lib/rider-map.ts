import type { DeliveryOrder, DeliveryStatus, Driver } from "@/hooks/use-delivery";

export interface RiderMarker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  at: string | null;
  activeDeliveries: number;
}

export interface RiderLocationEvent {
  id: string;
  lat: number;
  lng: number;
  at: string;
}

export interface DeliveryPin {
  id: string;
  orderNumber: string;
  lat: number;
  lng: number;
  status: DeliveryStatus;
  color: string;
  label: string;
}

export const STATUS_COLOR: Record<DeliveryStatus, string> = {
  UNASSIGNED: "#dc2626",
  ASSIGNED: "#d97706",
  PICKED_UP: "#2563eb",
  DELIVERED: "#16a34a",
  FAILED: "#6b7280",
};

const validPoint = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** On-duty riders that have shared a position. */
export function riderMarkers(drivers: Driver[]): RiderMarker[] {
  return drivers
    .filter((d) => d.riderOnline && validPoint(d.riderLat, d.riderLng))
    .map((d) => ({
      id: d.id,
      name: d.name,
      lat: d.riderLat as number,
      lng: d.riderLng as number,
      at: d.riderLocationAt,
      activeDeliveries: d.activeDeliveries,
    }));
}

/** Marker state reducer: apply one realtime location push. Returns the same array when nothing changes. */
export function applyRiderLocation(prev: RiderMarker[], ev: RiderLocationEvent): RiderMarker[] {
  if (!validPoint(ev.lat, ev.lng)) return prev;
  const i = prev.findIndex((m) => m.id === ev.id);
  if (i < 0) return prev;
  const cur = prev[i];
  if (cur.at && new Date(ev.at).getTime() < new Date(cur.at).getTime()) return prev;
  const next = prev.slice();
  next[i] = { ...cur, lat: ev.lat, lng: ev.lng, at: ev.at };
  return next;
}

/** Address pins for deliveries still in flight that have coordinates. */
export function deliveryPins(orders: DeliveryOrder[]): DeliveryPin[] {
  const pins: DeliveryPin[] = [];
  for (const o of orders) {
    const status = o.deliveryStatus ?? "UNASSIGNED";
    if (status === "DELIVERED" || status === "FAILED") continue;
    if (!validPoint(o.deliveryLat, o.deliveryLng)) continue;
    pins.push({
      id: o.id,
      orderNumber: o.orderNumber,
      lat: o.deliveryLat as number,
      lng: o.deliveryLng as number,
      status,
      color: STATUS_COLOR[status],
      label: `#${o.orderNumber} · ${o.guestName ?? "Guest"}`,
    });
  }
  return pins;
}

/** Apply a realtime location push to the cached driver list (query data). */
export function patchDriverLocation(drivers: Driver[] | undefined, ev: RiderLocationEvent): Driver[] | undefined {
  if (!drivers) return drivers;
  const markers = riderMarkers(drivers.filter((d) => d.id === ev.id));
  const moved = markers.length ? applyRiderLocation(markers, ev) : markers;
  if (markers.length && moved === markers) return drivers;
  if (!validPoint(ev.lat, ev.lng)) return drivers;
  return drivers.map((d) =>
    d.id === ev.id && d.riderOnline
      ? { ...d, riderLat: ev.lat, riderLng: ev.lng, riderLocationAt: ev.at }
      : d,
  );
}
