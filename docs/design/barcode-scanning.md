# POS keyboard-wedge barcode scanning (design, #381)

Status: proposed; independent design review required before implementation.

## Current state and scope

`MenuItem` already has nullable, branch-scoped `sku` and `barcode` fields (`apps/backend/prisma/schema.prisma`, model `MenuItem`); neither is unique. Menu reads require `menu.view` and `BranchAccess` (`apps/backend/src/modules/menu/menu.controller.ts`). POS order creation requires `orders.create`. A keyboard-wedge scanner presents keystrokes and typically an Enter suffix; the POS should add one matching saleable item using the existing cart flow, not create an order or take payment automatically.

## Interaction and data

- Provide a visible, keyboard-accessible scan field on POS with a clear scanner-ready state. Accept a complete bounded string and Enter, preserve leading zeroes, and avoid intercepting text typed in other fields, modal inputs, or IME composition. No camera or hardware permissions are needed.
- Match exact barcode first, then exact SKU; preserve existing values and case unless a documented normalization policy is approved. Never choose silently if multiple active matches exist, including barcode/SKU cross-field collisions. Show a disambiguation list or an actionable duplicate error. Missing, unavailable, archived or out-of-branch matches do not alter the cart.
- Reuse the existing add-item path so modifiers, portions, pricing, stock warnings and offline behavior remain consistent. If an item requires a choice, open the normal selection flow. For offline operation use only a currently authorized branch's cached menu and surface stale/unavailable data; do not promise availability when the existing cache cannot support it.

## Authorization, API and migration

Reuse `menu.view` for scoped lookup and `orders.create` for cart/order actions, enforced as permissions rather than role-name checks. Roles and their grants remain data; the locked Admin role is unchanged. Recheck restaurant and branch on every server lookup; no global search or cross-branch leakage. Prefer existing branch-scoped menu cache where sufficient; otherwise a Zod-validated bounded exact-match endpoint returning only POS-required fields with parameterized Prisma queries and duplicate signaling. Scanner input is untrusted data, never a command.

No schema migration is required for MVP. Before adding indexes or uniqueness, measure data and detect duplicate/cross-field collisions per branch; introduce any index in a separate safe migration after backup, without rejecting existing installs. Preserve existing menu import/edit behavior. The independent review should resolve whether duplicate matches should be selectable or blocked, and whether cache coverage supports offline scans.

## Tests and rollout

Unit-test bounded input, leading zeroes, barcode-vs-SKU precedence, duplicate/missing/inactive matches, typing/IME exclusions, and modifiers. API/database tests cover branch/restaurant isolation, authorization, duplicate records and input bounds. Playwright covers scan-to-cart, normal typing, required choices, unknown/duplicate codes and offline cache availability using synthetic data. Test accessibility and do not record scanned customer data. Start with a disabled-by-default pilot if device behavior varies; monitor only opt-in aggregate errors without raw codes.
