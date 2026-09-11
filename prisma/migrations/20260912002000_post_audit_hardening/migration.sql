-- Preserve a stable fingerprint for new idempotent requests. Existing rows stay
-- nullable so upgrades do not pretend to know the original request body.
ALTER TABLE "Job"
ADD COLUMN "idempotencyFingerprint" TEXT;

-- Execution heartbeats let startup recovery distinguish live work from work
-- abandoned by a crashed worker.
ALTER TABLE "JobExecution"
ADD COLUMN "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "JobExecution_status_heartbeatAt_idx"
ON "JobExecution"("status", "heartbeatAt");
