import { prisma } from "../db";
import { logger } from "../lib/logger";
import { ensureJobScheduled } from "./jobQueue";

export async function reconcileScheduledJobs() {
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
    { checked: scheduledJobs.length, repaired, failed },
    "scheduled-job reconciliation completed"
  );

  return { checked: scheduledJobs.length, repaired, failed };
}
