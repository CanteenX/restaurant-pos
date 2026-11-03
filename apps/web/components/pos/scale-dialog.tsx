"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MenuItem } from "@/hooks/use-menu";
import { formatCurrency } from "@/lib/format";
import {
  SimulatedScale,
  StableWeightDetector,
  formatNetWeight,
  linePriceForWeight,
  parseScaleFrame,
} from "@/lib/scale";

interface Props {
  open: boolean;
  items: MenuItem[];
  onClose: () => void;
  onConfirm: (item: MenuItem, label: string, price: number) => void;
}

// Sell-by-weight flow. Reads the software scale simulator; real adapters
// (serial / HID / network) plug in through ScaleAdapter.
export function ScaleDialog({ open, items, onClose, onConfirm }: Props) {
  const scale = useMemo(() => new SimulatedScale(), []);
  const detector = useRef(new StableWeightDetector({ readings: 3, toleranceGrams: 2 }));
  const [itemId, setItemId] = useState("");
  const [pricePerKg, setPricePerKg] = useState("");
  const [tare, setTare] = useState("0");
  const [placed, setPlaced] = useState("");
  const [settled, setSettled] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      const frame = parseScaleFrame(scale.readFrame());
      setSettled(frame ? detector.current.push(frame.grams, frame.stable) : null);
    }, 200);
    return () => clearInterval(id);
  }, [open, scale]);

  const item = items.find((i) => i.id === itemId);
  const gross = settled ?? 0;
  const tareG = Number(tare) || 0;
  const net = Math.max(0, gross - tareG);
  const price = linePriceForWeight({ pricePerKg: Number(pricePerKg) || 0, grossGrams: gross, tareGrams: tareG });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Weigh item</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="scale-item">Item</Label>
            <select
              id="scale-item"
              className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
              value={itemId}
              onChange={(e) => {
                setItemId(e.target.value);
                const it = items.find((i) => i.id === e.target.value);
                setPricePerKg(it ? String(Number(it.price)) : "");
              }}
            >
              <option value="">Select an item…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label htmlFor="scale-price">Price / kg</Label>
              <Input id="scale-price" inputMode="decimal" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="scale-tare">Tare (g)</Label>
              <Input id="scale-tare" inputMode="numeric" value={tare} onChange={(e) => setTare(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="scale-sim">Simulator (g)</Label>
              <Input
                id="scale-sim"
                inputMode="numeric"
                value={placed}
                onChange={(e) => {
                  setPlaced(e.target.value);
                  detector.current.reset();
                  scale.place(Number(e.target.value) || 0);
                }}
              />
            </div>
          </div>
          <div className="rounded-lg border border-border p-3 text-sm" data-testid="scale-readout">
            {settled === null ? (
              <span className="text-muted-foreground">Settling…</span>
            ) : (
              <>
                <div>Net weight: <span data-testid="scale-net">{formatNetWeight(net)}</span></div>
                <div>Price: <span data-testid="scale-price-total">{formatCurrency(price)}</span></div>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!item || settled === null || net <= 0 || price <= 0}
            onClick={() => {
              if (!item) return;
              onConfirm(item, formatNetWeight(net), price);
              onClose();
            }}
          >
            Add to cart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
