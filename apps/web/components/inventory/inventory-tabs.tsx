"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { scrollActiveTabIntoView } from "@/lib/scroll-active-tab";
import { cn } from "@/lib/utils";

const TABS: { key: TranslationKey; href: string }[] = [
  { key: "inv.tabs.ingredients", href: "/inventory" },
  { key: "inv.tabs.suppliers", href: "/inventory/suppliers" },
  { key: "inv.tabs.purchaseOrders", href: "/inventory/purchase-orders" },
  { key: "inv.tabs.procurement", href: "/inventory/procurement" },
  { key: "inv.tabs.transfers", href: "/inventory/transfers" },
  { key: "inv.tabs.waste", href: "/inventory/waste" },
];

export function InventoryTabs() {
  const { t } = useI18n();
  const pathname = usePathname();

  return (
    <nav className="flex min-w-0 max-w-full gap-1 overflow-x-auto border-b border-border">
      {TABS.map((tab) => {
        const isActive =
          tab.href === "/inventory" ? pathname === "/inventory" : pathname?.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            ref={isActive ? scrollActiveTabIntoView : undefined}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-t-md border-b-2 px-3 pb-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
