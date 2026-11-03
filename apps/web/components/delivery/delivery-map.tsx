"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { DeliveryOrder, Driver } from "@/hooks/use-delivery";
import { deliveryPins, riderMarkers } from "@/lib/rider-map";

const FALLBACK_CENTER: L.LatLngTuple = [20.5937, 78.9629];

// OSM tile policy: standard tile server, attribution shown, tiles fetched only
// for the visible viewport (no prefetch / no bulk download).
export default function DeliveryMap({ drivers, orders }: { drivers: Driver[]; orders: DeliveryOrder[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const [tilesFailed, setTilesFailed] = useState(false);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: FALLBACK_CENTER, zoom: 5 });
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    tiles.on("tileerror", () => setTilesFailed(true));
    tiles.on("tileload", () => setTilesFailed(false));
    tiles.addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const g = layer.current;
    const m = map.current;
    if (!g || !m) return;
    g.clearLayers();
    const points: L.LatLngTuple[] = [];
    for (const p of deliveryPins(orders)) {
      L.circleMarker([p.lat, p.lng], { radius: 8, color: p.color, fillColor: p.color, fillOpacity: 0.85 })
        .bindTooltip(`${p.label}`)
        .addTo(g);
      points.push([p.lat, p.lng]);
    }
    for (const r of riderMarkers(drivers)) {
      L.marker([r.lat, r.lng], { title: r.name })
        .bindTooltip(`${r.name} · ${r.activeDeliveries} active`)
        .addTo(g);
      points.push([r.lat, r.lng]);
    }
    if (!fitted.current && points.length > 0) {
      m.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 15 });
      fitted.current = true;
    }
  }, [drivers, orders]);

  return (
    <div className="relative">
      <div ref={el} data-testid="delivery-map" className="h-80 w-full rounded-xl border border-border" />
      {tilesFailed && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Map tiles could not load (offline?). Rider and delivery details are still listed below.
        </p>
      )}
    </div>
  );
}
