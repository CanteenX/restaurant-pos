import type { TranslationKey } from "@/lib/i18n/context";
import {
  CalendarClock,
  Clock,
  Gift,
  Tag,
  Bike,
  Truck,
  Users,
  Landmark,
  BarChart3,
  Megaphone,
  Wrench,
  ChefHat,
  LayoutDashboard,
  ClipboardList,
  LayoutGrid,
  Package,
  Settings,
  ShoppingCart,
  UsersRound,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  labelKey: TranslationKey;
  href: string;
  icon: LucideIcon;
  permission?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { labelKey: "nav.dashboard", href: "/dashboard", icon: LayoutDashboard, permission: "dashboard.sales.view" },
  { labelKey: "nav.pos", href: "/pos", icon: ShoppingCart, permission: "orders.create" },
  { labelKey: "nav.orders", href: "/orders", icon: ClipboardList, permission: "orders.create" },
  { labelKey: "nav.tables", href: "/tables", icon: LayoutGrid, permission: "tables.view" },
  {
    labelKey: "nav.reservations",
    href: "/reservations",
    icon: CalendarClock,
    permission: "reservations.manage",
  },
  { labelKey: "nav.menu", href: "/menu", icon: UtensilsCrossed, permission: "menu.view" },
  { labelKey: "nav.kds", href: "/kds", icon: ChefHat, permission: "kds.manage" },
  { labelKey: "nav.customers", href: "/customers", icon: UsersRound, permission: "customers.manage" },
  { labelKey: "nav.giftCards", href: "/gift-cards", icon: Gift, permission: "customers.manage" },
  { labelKey: "nav.labels", href: "/labels", icon: Tag, permission: "bills.print" },
  { labelKey: "nav.inventory", href: "/inventory", icon: Package, permission: "inventory.manage" },
  { labelKey: "nav.myDeliveries", href: "/my-deliveries", icon: Bike, permission: "delivery.rider" },
  { labelKey: "nav.delivery", href: "/delivery", icon: Truck, permission: "delivery.manage" },
  { labelKey: "nav.team", href: "/team", icon: Users, permission: "staff.manage" },
  { labelKey: "nav.accounting", href: "/accounting", icon: Landmark, permission: "accounting.manage" },
  { labelKey: "nav.reports", href: "/reports", icon: BarChart3, permission: "reports.access" },
  { labelKey: "nav.marketing", href: "/marketing", icon: Megaphone, permission: "marketing.manage" },
  { labelKey: "nav.operations", href: "/operations", icon: Wrench, permission: "operations.manage" },
  { labelKey: "nav.attendance", href: "/attendance", icon: Clock },
  { labelKey: "nav.settings", href: "/settings", icon: Settings, permission: "settings.manage" },
];

/**
 * Sub-pages gated by a different permission than their nav entry. The layout
 * checks these together with NAV_ITEMS (the longest matching href wins).
 */
export const EXTRA_ROUTE_GATES: { href: string; permission: string }[] = [
  { href: "/settings/email-templates", permission: "settings.emailTemplates" },
];
