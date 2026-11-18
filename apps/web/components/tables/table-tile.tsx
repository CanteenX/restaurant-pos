"use client";

import type { TableStatusDto } from "@nventra/types";
import { ClipboardList, Merge, Plus, QrCode, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUpdateTableStatus, type RestaurantTable } from "@/hooks/use-tables";
import { cn } from "@/lib/utils";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { BillTableDialog } from "./bill-table-dialog";
import { ElapsedTimer } from "./elapsed-timer";
import { MergeTableDialog } from "./merge-table-dialog";
import { TableQrDialog } from "./table-qr-dialog";
import { TableShapeIcon } from "./table-shape-icon";

const STATUS_STYLES: Record<TableStatusDto, string> = {
  AVAILABLE: "bg-success/10 border-success/30 text-success",
  OCCUPIED: "bg-primary/10 border-primary/30 text-primary",
  RESERVED: "bg-warning/10 border-warning/30 text-warning",
  CLEANING: "bg-muted border-border text-muted-foreground",
  OUT_OF_SERVICE: "bg-muted border-border text-muted-foreground opacity-60",
};

const STATUS_LABEL: Record<TableStatusDto, TranslationKey> = {
  AVAILABLE: "tables.status.available",
  OCCUPIED: "tables.status.occupied",
  RESERVED: "tables.status.reserved",
  CLEANING: "tables.status.cleaning",
  OUT_OF_SERVICE: "tables.status.outOfService",
};

export function TableTile({
  table,
  allTables,
  branchId,
  style,
}: {
  table: RestaurantTable;
  allTables: RestaurantTable[];
  branchId: string | null;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const updateStatus = useUpdateTableStatus(branchId);
  const [qrOpen, setQrOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={style}
          className={cn(
            "absolute flex flex-col items-center justify-center gap-1 rounded-2xl border-2 text-xs font-medium shadow-sm transition-transform hover:scale-[1.03]",
            STATUS_STYLES[table.status],
          )}
        >
          <TableShapeIcon shape={table.shape} capacity={table.capacity} className="h-6 w-6" />
          <span className="text-sm font-semibold">{table.name ?? `T${table.number}`}</span>
          <span className="flex items-center gap-1 text-[11px] opacity-80">
            <Users className="h-3 w-3" />
            {table.capacity}
          </span>
          {(table.status === "OCCUPIED" || table.status === "RESERVED") && (
            <ElapsedTimer since={table.statusSince} className="flex items-center gap-1 text-[10px] opacity-70" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {t("tables.tile.statusGuests", { status: t(STATUS_LABEL[table.status]), count: table.capacity })}
          </div>
          {(Object.keys(STATUS_LABEL) as TableStatusDto[]).map((status) => (
            <DropdownMenuItem
              key={status}
              disabled={status === table.status}
              onClick={() => updateStatus.mutate({ id: table.id, status })}
            >
              {t(STATUS_LABEL[status])}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setQrOpen(true)}>
            <QrCode className="h-4 w-4" />
            {t("tables.tile.viewQr")}
          </DropdownMenuItem>
          {(table.status === "AVAILABLE" || table.status === "RESERVED") && (
            <DropdownMenuItem onClick={() => router.push(`/pos?tableId=${table.id}`)}>
              <Plus className="h-4 w-4" />
              {t("tables.tile.newOrder")}
            </DropdownMenuItem>
          )}
          {table.status === "OCCUPIED" && (
            <>
              <DropdownMenuItem onClick={() => router.push(`/pos?tableId=${table.id}`)}>
                <Plus className="h-4 w-4" />
                {t("tables.tile.addRound")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setBillOpen(true)}>
                <ClipboardList className="h-4 w-4" />
                {t("tables.tile.billTable")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMergeOpen(true)}>
                <Merge className="h-4 w-4" />
                {t("tables.tile.mergeHere")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <TableQrDialog table={table} branchId={branchId} open={qrOpen} onOpenChange={setQrOpen} />
      <MergeTableDialog
        branchId={branchId}
        table={table}
        allTables={allTables}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
      />
      <BillTableDialog branchId={branchId} table={table} open={billOpen} onOpenChange={setBillOpen} />
    </>
  );
}
