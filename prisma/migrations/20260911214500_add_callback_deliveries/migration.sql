-- CreateEnum
CREATE TYPE "CallbackDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "callbackUrl" TEXT;

-- CreateTable
CREATE TABLE "CallbackDelivery" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "CallbackDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallbackDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallbackDelivery_executionId_key" ON "CallbackDelivery"("executionId");

-- CreateIndex
CREATE INDEX "CallbackDelivery_status_createdAt_idx" ON "CallbackDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CallbackDelivery_jobId_createdAt_idx" ON "CallbackDelivery"("jobId", "createdAt");

-- AddForeignKey
ALTER TABLE "CallbackDelivery" ADD CONSTRAINT "CallbackDelivery_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallbackDelivery" ADD CONSTRAINT "CallbackDelivery_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "JobExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
