# POS keyboard-wedge barcode scanning (design, #381)

Status: independently reviewed and approved at design commit `0c5af12835682f0be2b20fdf122f1d94f09ff55c`.

## Current state and scope

`MenuItem` already has nullable, branch-scoped `sku` and `barcode` fields (`apps/backend/prisma/schema.prisma`, model `MenuItem`); neither is unique. The web `MenuItem` type in `apps/web/hooks/use-menu.ts` currently omits both fields even though the menu API returns them, so the feature must extend that type and verify the data path. Menu reads require `menu.view` and `BranchAccess` (`apps/backend/src/modules/menu/menu.controller.ts`). POS order creation requires `orders.create`. A keyboard-wedge scanner presents keystrokes and typically an Enter suffix; the POS should add one matching saleable item using the existing cart flow, not create an order or take payment automatically.

## Interaction and data

- Provide a visible, keyboard-accessible scan field on POS with a clear scanner-ready state. Accept a complete bounded string and Enter, preserve leading zeroes, and avoid intercepting text typed in other fields, modal inputs, or IME composition. No camera or hardware permissions are needed.
- Match the exact input against both barcode and SKU in the current branch, preserving case and leading zeroes. Deduplicate by item ID: one active, saleable item may be added even if both fields match that same item. Two or more distinct matching items, including cross-field collisions, always block the scan and show an actionable duplicate error; no automatic selection or disambiguation in MVP. Missing, unavailable, inactive (`isActive = false`), archived or out-of-branch matches never alter the cart.
- Reuse the existing add-item path so modifiers, portions, pricing and stock warnings remain consistent. If an item requires a choice, open the normal selection flow. Offline scanning is disabled by default: enable it only when the existing POS can prove a complete, current-branch authorized menu snapshot with both fields and active status is available under its established freshness policy. Otherwise show an unavailable/stale message and leave the cart unchanged; never search a partial, stale or other-branch cache. Implementation must first verify that such a completeness and freshness guarantee exists; if it does not, retain online-only scanning.

## Authorization, API and migration

Reuse `menu.view` for scoped lookup and `orders.create` for cart/order actions, enforced as permissions rather than role-name checks. Roles and their grants remain data; the locked Admin role is unchanged. Recheck restaurant and branch on every server lookup; no global search or cross-branch leakage. Prefer existing branch-scoped menu cache where sufficient; otherwise a Zod-validated bounded exact-match endpoint returning only POS-required fields with parameterized Prisma queries and duplicate signaling. Scanner input is untrusted data, never a command.

No schema migration is required for MVP. Before adding indexes or uniqueness, measure data and detect duplicate/cross-field collisions per branch; introduce any index in a separate safe migration after backup, without rejecting existing installs. Preserve existing menu import/edit behavior. Offline capability is conditional on proving the cache guarantee above, not a prerequisite for online scanning.

## Tests and rollout

Unit-test bounded input, leading zeroes, a single item matching both fields, cross-field and same-field duplicates, missing/inactive matches, typing/IME exclusions, and modifiers. API/database tests cover branch/restaurant isolation, authorization, duplicate records and input bounds. Playwright covers scan-to-cart, normal typing, required choices, unknown/duplicate codes and offline disabled behavior; if a complete fresh cache is proven, also test stale, incomplete and wrong-branch snapshots. Use synthetic data, test accessibility and do not record scanned customer data. Start with a disabled-by-default pilot if device behavior varies; monitor only opt-in aggregate errors without raw codes.
