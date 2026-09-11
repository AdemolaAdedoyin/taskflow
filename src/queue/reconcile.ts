import { prisma } from "../db";
import { logger } from "../lib/logger";
import { enqueueCallbackDelivery } from "./callbackQueue";
import { recoverStaleExecutions } from "./executionLease";
import { ensureJobScheduled } from "./jobQueue";

export async function reconcileScheduledJobs() {
  const stale = await recoverStaleExecutions();
  if (stale.recovered > 0) {
    logger.warn(stale, "recovered stale RUNNING executions before queue reconciliation");
  }

  const scheduledJobs = await prisma.job.findMany({
    where: { status: "SCHEDULED" },
    orderBy: { createdAt: "asc" },
  });

  let repaired = 0;
  let failed = 0;

  for (const job of scheduledJobs) {
    try {
      await ensureJobScheduled(job);
      repaired += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, jobId: job.id }, "failed to reconcile scheduled job into Redis");
    }
  }

  logger.info(
    { checked: scheduledJobs.length, repaired, failed, staleRecovered: stale.recovered },
    "scheduled-job reconciliation completed"
  );

  return { checked: scheduledJobs.length, repaired, failed, staleRecovered: stale.recovered };
}

export async function reconcilePendingCallbacks() {
  const pending = await prisma.callbackDelivery.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 1_000,
  });

  let repaired = 0;
  let failed = 0;
  for (const delivery of pending) {
    try {
      await enqueueCallbackDelivery(delivery.id);
      repaired += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, deliveryId: delivery.id }, "failed to reconcile callback delivery into Redis");
    }
  }

  logger.info(
    { checked: pending.length, repaired, failed },
    "callback-delivery reconciliation completed"
  );
  return { checked: pending.length, repaired, failed };
}
