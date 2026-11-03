"use client";

import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CartLine } from "@/components/pos/cart-line";
import { SavedAddressPicker } from "@/components/pos/saved-address-picker";
import type { RestaurantTable } from "@/hooks/use-tables";
import { subtotalOf } from "@/lib/pricing-preview";
import { useI18n } from "@/lib/i18n/context";

export type PosOrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";
export interface DeliveryDetails {
  address: string;
  pincode: string;
  phone: string;
}

export function CartPanel({
  lines,
  orderType,
  onOrderTypeChange,
  tables,
  tableId,
  onTableChange,
  onIncrement,
  onDecrement,
  onRemove,
  onSubmit,
  isSubmitting,
  existingOrderNumber,
  onViewExistingOrder,
  openBills,
  selectedBillId,
  onSelectBill,
  checkingTable = false,
  delivery,
  onDeliveryChange,
  scheduledFor,
  onScheduledForChange,
  branchId = null,
}: {
  lines: CartLine[];
  orderType: PosOrderType;
  onOrderTypeChange: (type: PosOrderType) => void;
  tables: RestaurantTable[];
  tableId: string;
  onTableChange: (id: string) => void;
  onIncrement: (key: string) => void;
  onDecrement: (key: string) => void;
  onRemove: (key: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  existingOrderNumber?: string;
  onViewExistingOrder?: () => void;
  /** All unpaid bills on the selected table (more than one is possible). */
  openBills?: { id: string; orderNumber: string }[];
  selectedBillId?: string | null;
  onSelectBill?: (id: string) => void;
  /** The table's open bills are still loading - sending now could start a duplicate bill. */
  checkingTable?: boolean;
  delivery: DeliveryDetails;
  onDeliveryChange: (d: DeliveryDetails) => void;
  scheduledFor: string;
  onScheduledForChange: (v: string) => void;
  /** Used to look up a returning customer's saved addresses by phone. */
  branchId?: string | null;
}) {
  const { t, formatCurrency } = useI18n();
  const subtotal = subtotalOf(lines.map((l) => l.unitPrice * l.quantity));
  const deliveryReady =
    orderType !== "DELIVERY" ||
    (delivery.address.trim().length >= 5 && delivery.pincode.trim().length >= 3 && delivery.phone.trim().length >= 6);
  const canSubmit =
    lines.length > 0 && (orderType !== "DINE_IN" || !!tableId) && deliveryReady && !isSubmitting && !checkingTable;

  return (
    <div className="flex h-full flex-col gap-4">
      <Tabs value={orderType} onValueChange={(v) => onOrderTypeChange(v as PosOrderType)}>
        <TabsList className="w-full">
          <TabsTrigger value="DINE_IN" className="flex-1">
            {t("pos.orderType.dineIn")}
          </TabsTrigger>
          <TabsTrigger value="TAKEAWAY" className="flex-1">
            {t("pos.orderType.takeaway")}
          </TabsTrigger>
          <TabsTrigger value="DELIVERY" className="flex-1">
            {t("pos.orderType.delivery")}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {orderType === "DINE_IN" && (
        <Select value={tableId} onValueChange={(v) => onTableChange(v ?? "")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("pos.selectTable")}>
              {(value: string | null) => {
                const tbl = tables.find((table) => table.id === value);
                if (!tbl) return t("pos.selectTable");
                return `${tbl.name ?? t("pos.tableNumber", { number: tbl.number })}${tbl.status === "OCCUPIED" ? ` ${t("pos.occupiedSuffix")}` : ""}`;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {tables.map((tbl) => (
              <SelectItem key={tbl.id} value={tbl.id}>
                {tbl.name ?? t("pos.tableNumber", { number: tbl.number })} {tbl.status === "OCCUPIED" ? t("pos.occupiedSuffix") : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {orderType === "DELIVERY" && (
        <div className="flex flex-col gap-2">
          <Input
            placeholder={t("pos.deliveryAddress")}
            value={delivery.address}
            onChange={(e) => onDeliveryChange({ ...delivery, address: e.target.value })}
          />
          <SavedAddressPicker
            branchId={branchId}
            phone={delivery.phone}
            onPick={(address, pincode) => onDeliveryChange({ ...delivery, address, pincode })}
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder={t("pos.pincode")}
              inputMode="numeric"
              value={delivery.pincode}
              onChange={(e) => onDeliveryChange({ ...delivery, pincode: e.target.value })}
            />
            <Input
              placeholder={t("pos.phone")}
              inputMode="tel"
              value={delivery.phone}
              onChange={(e) => onDeliveryChange({ ...delivery, phone: e.target.value })}
            />
          </div>
        </div>
      )}

      {orderType !== "DINE_IN" && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("pos.scheduleLater")}
          <Input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => onScheduledForChange(e.target.value)}
          />
        </label>
      )}

      {checkingTable && (
        <p role="status" className="rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          {t("pos.checkingBills")}
        </p>
      )}
      {openBills && openBills.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="group" aria-label={t("pos.openBillsAria")}>
          <span>{t("pos.openBillsAddTo", { count: openBills.length })}</span>
          {openBills.map((b) => (
            <Button
              key={b.id}
              type="button"
              size="sm"
              variant={b.id === selectedBillId ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              aria-pressed={b.id === selectedBillId}
              onClick={() => onSelectBill?.(b.id)}
            >
              #{b.orderNumber}
            </Button>
          ))}
        </div>
      )}
      {existingOrderNumber && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {t("pos.existingOrder")}{" "}
            <span className="font-medium text-foreground">#{existingOrderNumber}</span>
            {lines.length > 0 && t("pos.existingOrderAddRound")}
          </span>
          {onViewExistingOrder && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={onViewExistingOrder}
            >
              {t("pos.viewAndPay")}
            </Button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <ShoppingCart className="h-8 w-8 opacity-40" />
            <p className="text-sm">{t("pos.cartEmpty")}</p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {lines.map((line) => (
              <div key={line.key} className="flex items-start justify-between gap-3 py-3">
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{line.name}</p>
                  {line.modifierLabel && (
                    <p className="text-xs text-muted-foreground">{line.modifierLabel}</p>
                  )}
                  <p className="mt-1 text-sm font-medium tabular-nums text-foreground">
                    {formatCurrency(line.unitPrice * line.quantity)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onDecrement(line.key)}
                  >
                    <Minus className="h-3 w-3" />
                  </Button>
                  <span className="w-5 text-center text-sm tabular-nums">{line.quantity}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onIncrement(line.key)}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => onRemove(line.key)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("pos.subtotalInclTax")}</span>
          <span className="font-semibold tabular-nums text-foreground">
            {formatCurrency(subtotal)}
          </span>
        </div>
        <Button className="h-11" disabled={!canSubmit} onClick={onSubmit}>
          {isSubmitting
            ? t("pos.sendingToKitchen")
            : existingOrderNumber
              ? t("pos.addAndSend")
              : t("pos.sendToKitchen")}
        </Button>
      </div>
    </div>
  );
}
