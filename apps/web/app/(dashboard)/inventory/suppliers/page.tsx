"use client";

import { ChevronDown, Mail, Phone } from "lucide-react";
import { useState } from "react";
import { SupplierPerformancePanel } from "@/components/inventory/supplier-performance-panel";
import { AddSupplierDialog } from "@/components/inventory/add-supplier-dialog";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranch } from "@/hooks/use-branch";
import { useSuppliers } from "@/hooks/use-inventory";
import { useI18n } from "@/lib/i18n/context";

export default function SuppliersPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: suppliers, isLoading } = useSuppliers(branchId);

  const filtered = suppliers?.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("inv.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("inv.subtitle")}
          </p>
        </div>
        <AddSupplierDialog branchId={branchId} />
      </div>

      <InventoryTabs />

      <Input
        placeholder={t("inv.suppliers.search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      <Card className="flex flex-col divide-y divide-border p-2">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : filtered && filtered.length > 0 ? (
          filtered.map((s) => (
            <div key={s.id} className="flex flex-col">
              <button
                type="button"
                aria-expanded={openId === s.id}
                aria-label={t("inv.suppliers.performanceFor", { name: s.name })}
                onClick={() => setOpenId(openId === s.id ? null : s.id)}
                className="flex min-h-11 items-center justify-between gap-4 px-4 py-3 text-left"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.contactName || t("inv.suppliers.noContact")}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  {s.phone && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-3.5 w-3.5" />
                      {s.phone}
                    </span>
                  )}
                  {s.email && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5" />
                      {s.email}
                    </span>
                  )}
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${openId === s.id ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </div>
              </button>
              {openId === s.id && <SupplierPerformancePanel branchId={branchId} supplierId={s.id} />}
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t("inv.suppliers.empty.title")}</p>
            <p className="text-sm text-muted-foreground">
              {t("inv.suppliers.empty.body")}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
