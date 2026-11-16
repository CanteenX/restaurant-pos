-- Email templates 1/5 (#220): per-restaurant email templates and branding.
-- Additive only: two new tables, no change to existing ones. down.sql next to
-- this file reverses it.

-- CreateTable
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "buttonText" TEXT,
    "buttonUrl" TEXT,
    "footer" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_branding" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL DEFAULT '#9F1239',
    "headerText" TEXT,
    "footerText" TEXT,
    "logoUrl" TEXT,
    "replyTo" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "email_branding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_restaurantId_key_key" ON "email_templates"("restaurantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "email_branding_restaurantId_key" ON "email_branding"("restaurantId");

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_branding" ADD CONSTRAINT "email_branding_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

