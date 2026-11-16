"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { hasPermission, useCurrentUser } from "@/hooks/use-auth";
import { useNavBadges } from "@/hooks/use-nav-badges";
import { useBranch } from "@/hooks/use-branch";
import { useSettings } from "@/hooks/use-settings";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { scrollActiveTabIntoView } from "@/lib/scroll-active-tab";
import { cn } from "@/lib/utils";
import { NavDot } from "@/components/layout/nav-dot";

interface SettingsTab {
  /** Dictionary key; omit when `label` is a brand name that is never translated. */
  labelKey?: TranslationKey;
  label?: string;
  href: string;
  /** Omit to show the tab to anyone who can reach /settings at all. */
  permission?: string;
  /** Only shown for branches in this country (ISO code). */
  country?: string;
}

const TABS: SettingsTab[] = [
  { labelKey: "settings.tabs.general", href: "/settings" },
  { labelKey: "settings.tabs.staff", href: "/settings/staff", permission: "users.manage" },
  { labelKey: "settings.tabs.roles", href: "/settings/roles", permission: "roles.manage" },
  { labelKey: "settings.tabs.memberships", href: "/settings/memberships", permission: "memberships.manage" },
  { labelKey: "settings.tabs.auditLog", href: "/settings/audit-log", permission: "audit_log.view" },
  { labelKey: "settings.tabs.backup", href: "/settings/backup", permission: "backup.manage" },
  { labelKey: "settings.tabs.updates", href: "/settings/updates", permission: "system.update" },
  { labelKey: "settings.tabs.sync", href: "/settings/sync", permission: "settings.manage" },
  { labelKey: "settings.tabs.integrations", href: "/settings/integrations", permission: "settings.manage" },
  { labelKey: "settings.tabs.apiKeys", href: "/settings/api-keys" },
  { labelKey: "settings.tabs.security", href: "/settings/security" },
  { labelKey: "settings.tabs.webhooks", href: "/settings/webhooks", permission: "settings.manage" },
  { label: "VERI*FACTU", href: "/settings/verifactu", permission: "settings.manage", country: "ES" },
];

export function SettingsTabs() {
  const { t } = useI18n();
  const pathname = usePathname();
  const { data } = useCurrentUser();
  const user = data?.user;
  const badges = useNavBadges();
  const { branchId } = useBranch();
  const branchCountry = useSettings(branchId).data?.branch.country;

  const visibleTabs = TABS.filter(
    (tab) =>
      (!tab.permission || hasPermission(user, tab.permission)) &&
      (!tab.country || branchCountry === tab.country),
  );

  return (
    <nav className="flex min-w-0 max-w-full gap-1 overflow-x-auto border-b border-border">
      {visibleTabs.map((tab) => {
        const isActive =
          tab.href === "/settings" ? pathname === "/settings" : pathname?.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            ref={isActive ? scrollActiveTabIntoView : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md border-b-2 px-3 pb-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.labelKey ? t(tab.labelKey) : tab.label}
            {badges.settingsTabs[tab.href] ? <NavDot className="ml-0" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
