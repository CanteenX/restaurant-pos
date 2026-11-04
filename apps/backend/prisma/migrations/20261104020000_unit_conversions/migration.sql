-- Unit conversion engine (#69). Non-destructive:
--  * Every stored quantity stays in the ingredient's base unit, so no existing
--    quantity is rewritten or rescaled.
--  * Cost columns widen from DECIMAL(12,4) to DECIMAL(14,6) so per-gram /
--    per-ml costs converted from per-kg / per-litre prices are not truncated.
--    Widening precision and scale preserves every existing value exactly.
--  * New nullable "entered*" columns record what the user typed; NULL means
--    the base unit (every existing row).
--  * New per-ingredient pack-size table.

-- AlterTable
ALTER TABLE "goods_receipt_items" ADD COLUMN     "enteredQuantity" DECIMAL(12,3),
ADD COLUMN     "enteredUnit" "IngredientUnit",
ADD COLUMN     "enteredUnitCost" DECIMAL(14,6),
ALTER COLUMN "unitCost" SET DATA TYPE DECIMAL(14,6);

-- AlterTable
ALTER TABLE "ingredients" ALTER COLUMN "costPerUnit" SET DATA TYPE DECIMAL(14,6);

-- AlterTable
ALTER TABLE "recipe_ingredients" ADD COLUMN     "enteredQuantity" DECIMAL(12,3),
ADD COLUMN     "enteredUnit" "IngredientUnit";

-- AlterTable
ALTER TABLE "stock_batches" ALTER COLUMN "unitCost" SET DATA TYPE DECIMAL(14,6);

-- AlterTable
ALTER TABLE "waste_logs" ALTER COLUMN "unitCostAtWaste" SET DATA TYPE DECIMAL(14,6);

-- CreateTable
CREATE TABLE "ingredient_unit_conversions" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "unit" "IngredientUnit" NOT NULL,
    "factor" DECIMAL(14,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredient_unit_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_unit_conversions_ingredientId_unit_key" ON "ingredient_unit_conversions"("ingredientId", "unit");

-- AddForeignKey
ALTER TABLE "ingredient_unit_conversions" ADD CONSTRAINT "ingredient_unit_conversions_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

