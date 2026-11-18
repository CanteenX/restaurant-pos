import { CalendarPlus, ChefHat, LayoutGrid, ShoppingCart, UtensilsCrossed } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";

const ACTIONS: { href: string; label: TranslationKey; icon: typeof ShoppingCart }[] = [
  { href: "/pos", label: "dashboard.quick.newOrder", icon: ShoppingCart },
  { href: "/tables", label: "dashboard.quick.tables", icon: LayoutGrid },
  { href: "/reservations", label: "dashboard.quick.newReservation", icon: CalendarPlus },
  { href: "/kds", label: "dashboard.quick.kds", icon: ChefHat },
  { href: "/menu", label: "dashboard.quick.menu", icon: UtensilsCrossed },
];

// One-tap jumps into the flows staff reach for most during service — sits
// right under the header so it's the first thing visible, not buried below
// the stat cards.
export function QuickActions() {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-2">
      {ACTIONS.map((action) => (
        <Button key={action.href} variant="outline" size="sm" render={<Link href={action.href} />}>
          <action.icon className="h-4 w-4" />
          {t(action.label)}
        </Button>
      ))}
    </div>
  );
}
