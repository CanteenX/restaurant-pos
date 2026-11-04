"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateReservation } from "@/hooks/use-reservations";
import type { RestaurantTable } from "@/hooks/use-tables";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { parseDepositInput } from "@/lib/reservation-deposit";

function defaultDateTimeLocal() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return d.toISOString().slice(0, 16);
}

export function AddReservationDialog({
  branchId,
  tables,
}: {
  branchId: string | null;
  tables: RestaurantTable[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [guestCount, setGuestCount] = useState("2");
  const [reservedAt, setReservedAt] = useState(defaultDateTimeLocal());
  const [tableId, setTableId] = useState("");
  const [specialRequests, setSpecialRequests] = useState("");
  const [deposit, setDeposit] = useState("");

  const createReservation = useCreateReservation(branchId);

  const reset = () => {
    setCustomerName("");
    setPhone("");
    setGuestCount("2");
    setReservedAt(defaultDateTimeLocal());
    setTableId("");
    setSpecialRequests("");
    setDeposit("");
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedDeposit = parseDepositInput(deposit);
    if (!parsedDeposit.ok) {
      toast.error(t("reservations.add.depositInvalid"));
      return;
    }
    createReservation.mutate(
      {
        customerName,
        phone: phone || undefined,
        guestCount: Number(guestCount),
        reservedAt: new Date(reservedAt),
        durationMinutes: 90,
        tableId: tableId || undefined,
        specialRequests: specialRequests || undefined,
        deposit: parsedDeposit.value,
      },
      {
        onSuccess: () => {
          toast.success(t("reservations.add.added", { name: customerName }));
          setOpen(false);
          reset();
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.message : t("reservations.add.error")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm">{t("reservations.add.title")}</Button>} />
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("reservations.add.title")}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="r-name">{t("reservations.add.customerName")}</Label>
            <Input
              id="r-name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-phone">{t("reservations.add.phone")}</Label>
              <Input id="r-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="r-guests">{t("reservations.add.guests")}</Label>
              <Input
                id="r-guests"
                type="number"
                min="1"
                value={guestCount}
                onChange={(e) => setGuestCount(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="r-when">{t("reservations.add.dateTime")}</Label>
            <Input
              id="r-when"
              type="datetime-local"
              value={reservedAt}
              onChange={(e) => setReservedAt(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t("reservations.add.tableOptional")}</Label>
            <Select value={tableId} onValueChange={(v) => setTableId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder={t("reservations.add.noTable")} />
              </SelectTrigger>
              <SelectContent>
                {tables.map((tb) => (
                  <SelectItem key={tb.id} value={tb.id}>
                    {tb.name ?? t("tables.tableLabel", { number: tb.number })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="r-deposit">{t("reservations.add.depositOptional")}</Label>
            <Input
              id="r-deposit"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="r-notes">{t("reservations.add.specialRequests")}</Label>
            <Textarea
              id="r-notes"
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={createReservation.isPending}>
              {createReservation.isPending ? t("tables.saving") : t("reservations.add.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
