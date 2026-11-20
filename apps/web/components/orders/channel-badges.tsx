import { Badge } from "@/components/ui/badge";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

// Online = guest ordered via website/QR; Offline = entered by staff.
export function ChannelBadge({ channel }: { channel: "STAFF" | "ONLINE" }) {
  const { t } = useI18n();
  const online = channel === "ONLINE";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "font-normal",
        online ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
      )}
    >
      {online ? t("orders.channel.online") : t("orders.channel.offline")}
    </Badge>
  );
}

export const ORDER_TYPE_LABEL: Record<string, TranslationKey> = {
  DINE_IN: "orders.type.dineIn",
  TAKEAWAY: "orders.type.takeaway",
  DELIVERY: "orders.type.delivery",
  DRIVE_THRU: "orders.type.driveThru",
  QR_ORDER: "orders.type.qrOrder",
  KIOSK: "orders.type.kiosk",
  PHONE: "orders.type.phone",
};

export function TypeBadge({ type }: { type: string }) {
  const { t } = useI18n();
  const key = ORDER_TYPE_LABEL[type];
  return (
    <Badge variant="secondary" className="font-normal">
      {key ? t(key) : type.replace("_", " ")}
    </Badge>
  );
}
