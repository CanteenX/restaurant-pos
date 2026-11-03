-- CreateTable
CREATE TABLE "local_backup_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN,
    "directory" TEXT,
    "intervalHours" INTEGER,
    "retainCount" INTEGER,
    "lastSuccessAt" TIMESTAMP(3),
    "lastSuccessPath" TEXT,
    "lastSizeBytes" INTEGER,
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "local_backup_config_pkey" PRIMARY KEY ("id")
);
