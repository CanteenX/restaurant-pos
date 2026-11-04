-- Purchase-return cost precision (#193). Widens purchase_return_items.unitCost
-- from DECIMAL(12,4) to DECIMAL(14,6), matching goods_receipt_items.unitCost
-- after the unit-conversion migration, so returns of per-gram / per-ml items
-- are valued at the cost they were received at. Widening keeps every existing
-- value exactly (8 integer digits either way). The scale change rewrites
-- purchase_return_items under an ACCESS EXCLUSIVE lock (a small table).
-- Not cleanly reversible: narrowing back would round 6dp costs written since.

-- AlterTable
ALTER TABLE "purchase_return_items" ALTER COLUMN "unitCost" SET DATA TYPE DECIMAL(14,6);
