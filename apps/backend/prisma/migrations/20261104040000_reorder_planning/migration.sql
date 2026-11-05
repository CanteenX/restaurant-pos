-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN "leadTimeDays" INTEGER,
ADD COLUMN "packSize" DECIMAL(12,3),
ADD COLUMN "preferredSupplierId" TEXT;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_preferredSupplierId_fkey" FOREIGN KEY ("preferredSupplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
