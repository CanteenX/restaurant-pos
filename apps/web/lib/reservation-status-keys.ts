import type { ReservationStatusDto } from "@nventra/types";
import type { TranslationKey } from "@/lib/i18n/context";

/** Translation key for each reservation status label. */
export const RESERVATION_STATUS_KEY: Record<ReservationStatusDto, TranslationKey> = {
  RESERVED: "reservations.status.reserved",
  CONFIRMED: "reservations.status.confirmed",
  ARRIVED: "reservations.status.arrived",
  COMPLETED: "reservations.status.completed",
  CANCELLED: "reservations.status.cancelled",
  NO_SHOW: "reservations.status.noShow",
};
