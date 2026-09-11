import { Worker, Job as BullJob } from "bullmq";
import { prisma } from "../db";
import { config } from "../config";
import { logger } from "../lib/logger";
import { redisConnection } from "./connection";
import { QUEUE_NAME, JobPayload, getNextRecurringRun } from "./jobQueue";
import { getHandler } from "./handlers";

/**
 * Processes one firing of a job (one-off or one cron tick of a recurring
 * job). Retries within a single firing are handled by BullMQ itself (via the
 * `attempts` + `backoff` options set at enqueue time) — this function just
 * needs to run the handler and record what happened; throwing lets BullMQ
 * decide whether to retry or give up.
 */
async function processJob(bullJob: BullJob<JobPayload>) {
  const { jobId } = bullJob.data;
  const attemptNumber = bullJob.attemptsMade + 1;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    logger.warn({ jobId }, "job definition not found, skipping (likely deleted)");
    return;
  }
  if (job.status === "CANCELLED") {
    logger.info({ jobId }, "job was cancelled, skipping this firing");
    return;
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "RUNNING", attemptCount: attemptNumber, lastRunAt: new Date() },
  });

  const execution = await prisma.jobExecution.create({
    data: { jobId, attemptNumber, status: "RUNNING" },
  });

  const startedAt = Date.now();
  try {
    const handler = getHandler(job.type);
    const result = await handler(job.payload, { jobId, attemptNumber });
    const durationMs = Date.now() - startedAt;

    await prisma.jobExecution.update({
      where: { id: execution.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), durationMs, result: result as any },
    });

    await finalizeJobAfterRun(job.id, job.scheduleType, { succeeded: true });
    logger.info({ jobId, attemptNumber, durationMs }, "job succeeded");
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = err?.message ?? "Unknown error";

    await prisma.jobExecution.update({
      where: { id: execution.id },
      data: { status: "FAILED", finishedAt: new Date(), durationMs, error: errorMessage },
    });

    const isLastAttempt = attemptNumber >= job.maxAttempts;
    await prisma.job.update({
      where: { id: jobId },
      data: { lastError: errorMessage },
    });

    if (isLastAttempt) {
      await finalizeJobAfterRun(job.id, job.scheduleType, { succeeded: false });
      logger.warn({ jobId, attemptNumber }, "job exhausted all attempts");
    } else {
      logger.info({ jobId, attemptNumber }, "job attempt failed, BullMQ will retry with backoff");
    }

    // Re-throw so BullMQ's attempts/backoff configuration takes over.
    throw err;
  }
}

async function finalizeJobAfterRun(
  jobId: string,
  scheduleType: "ONCE" | "RECURRING",
  outcome: { succeeded: boolean }
) {
  if (scheduleType === "ONCE") {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: outcome.succeeded ? "SUCCEEDED" : "FAILED" },
    });
    return;
  }

  // Recurring jobs go back to SCHEDULED and wait for their next cron tick.
  const nextRunAt = await getNextRecurringRun(jobId);
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "SCHEDULED", attemptCount: 0, nextRunAt },
  });
}

export const jobWorker = new Worker<JobPayload>(QUEUE_NAME, processJob, {
  connection: redisConnection,
  concurrency: config.JOB_CONCURRENCY,
});

jobWorker.on("error", (err) => {
  logger.error({ err }, "worker-level error (e.g. Redis connection issue)");
});

logger.info("taskflow worker started");
