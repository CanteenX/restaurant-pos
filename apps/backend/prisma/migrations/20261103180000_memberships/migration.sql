-- Membership tiers and customer enrolments. Additive only: two new tables,
-- no change to existing rows or columns.

-- CreateTable
CREATE TABLE "membership_tiers" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "pointsMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1,
    "durationDays" INTEGER,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_memberships" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "membership_tiers_restaurantId_name_key" ON "membership_tiers"("restaurantId", "name");

-- CreateIndex
CREATE INDEX "customer_memberships_customerId_startsAt_idx" ON "customer_memberships"("customerId", "startsAt");

-- CreateIndex
CREATE INDEX "customer_memberships_tierId_idx" ON "customer_memberships"("tierId");

-- AddForeignKey
ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "membership_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one open enrolment per customer (concurrent enrols cannot both
-- win). Not expressible in schema.prisma, so it lives here only.
CREATE UNIQUE INDEX "customer_memberships_one_open_per_customer"
  ON "customer_memberships"("customerId") WHERE "endedAt" IS NULL;
