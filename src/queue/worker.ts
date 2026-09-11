import { Job, JobExecution } from "@prisma/client";
import { Worker, Job as BullJob } from "bullmq";
import { prisma } from "../db";
import { config } from "../config";
import { logger } from "../lib/logger";
import { CALLBACK_QUEUE_NAME, CallbackPayload, closeCallbackQueueResources } from "./callbackQueue";
import { deliverCallback, scheduleCompletionCallback } from "./callbackDelivery";
import { redisConnection } from "./connection";
import { QUEUE_NAME, JobPayload, closeQueueResources, getNextRecurringRun } from "./jobQueue";
import { getHandler } from "./handlers";
import { reconcilePendingCallbacks } from "./reconcile";

async function queueCompletionCallback(job: Job, execution: JobExecution) {
  if (!job.callbackUrl) return;
  try {
    await scheduleCompletionCallback(job, execution);
  } catch (error) {
    // Callback delivery is intentionally decoupled from the business handler.
    // A Redis outage must not turn a successfully executed job into a retry.
    // If the durable delivery row was created, startup reconciliation repairs it.
    logger.error({ err: error, jobId: job.id, executionId: execution.id }, "failed to enqueue completion callback");
  }
}

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

  if (bullJob.attemptsMade === 0) {
    // First attempts must atomically claim durable SCHEDULED state. This both
    // prevents overlapping recurring firings and closes the race where a
    // one-off worker could overwrite a concurrent CANCELLED transition after
    // its initial read.
    const claim = await prisma.job.updateMany({
      where: { id: jobId, status: "SCHEDULED" },
      data: { status: "RUNNING", attemptCount: attemptNumber, lastRunAt: new Date() },
    });

    if (claim.count === 0) {
      const latest = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
      logger.info(
        { jobId, status: latest?.status, scheduleType: job.scheduleType },
        "skipping unclaimable first firing"
      );
      return;
    }
  } else {
    // Retries belong to a firing that already owns the durable RUNNING state.
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "RUNNING", attemptCount: attemptNumber, lastRunAt: new Date() },
    });
  }

  const execution = await prisma.jobExecution.create({
    data: { jobId, attemptNumber, status: "RUNNING" },
  });

  const startedAt = Date.now();
  try {
    const handler = getHandler(job.type);
    const result = await handler(job.payload, { jobId, attemptNumber });
    const durationMs = Date.now() - startedAt;

    const completedExecution = await prisma.jobExecution.update({
      where: { id: execution.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), durationMs, result: result as any },
    });

    await finalizeJobAfterRun(job.id, job.scheduleType, { succeeded: true });
    await queueCompletionCallback(job, completedExecution);
    logger.info({ jobId, attemptNumber, durationMs }, "job succeeded");
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = err?.message ?? "Unknown error";

    const failedExecution = await prisma.jobExecution.update({
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
      await queueCompletionCallback(job, failedExecution);
      logger.warn({ jobId, attemptNumber }, "job exhausted all attempts");
    } else {
      logger.info({ jobId, attemptNumber }, "job attempt failed, BullMQ will retry with backoff");
    }

    // Re-throw so BullMQ's attempts/backoff configuration takes over.
    throw err;
  }
}

async function processCallback(bullJob: BullJob<CallbackPayload>) {
  const attemptNumber = bullJob.attemptsMade + 1;
  await deliverCallback(bullJob.data.deliveryId, attemptNumber);
  logger.info({ deliveryId: bullJob.data.deliveryId, attemptNumber }, "completion callback delivered");
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
  await prisma.job.updateMany({
    // Do not resurrect a job cancelled while a handler was finishing.
    where: { id: jobId, status: { not: "CANCELLED" } },
    data: { status: "SCHEDULED", attemptCount: 0, nextRunAt },
  });
}

export const jobWorker = new Worker<JobPayload>(QUEUE_NAME, processJob, {
  connection: redisConnection,
  concurrency: config.JOB_CONCURRENCY,
});

export const callbackWorker = new Worker<CallbackPayload>(CALLBACK_QUEUE_NAME, processCallback, {
  connection: redisConnection,
  concurrency: config.CALLBACK_CONCURRENCY,
});

jobWorker.on("error", (err) => {
  logger.error({ err }, "job worker-level error (e.g. Redis connection issue)");
});

callbackWorker.on("error", (err) => {
  logger.error({ err }, "callback worker-level error (e.g. Redis connection issue)");
});

void reconcilePendingCallbacks().catch((error) => {
  logger.error({ err: error }, "worker callback reconciliation failed");
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutdown requested");

  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref();

  try {
    // BullMQ waits for active handlers/deliveries to settle and stops taking new work.
    await Promise.all([jobWorker.close(), callbackWorker.close()]);
    await closeCallbackQueueResources();
    await closeQueueResources();
    await prisma.$disconnect();
    clearTimeout(forceExit);
    logger.info("taskflow worker stopped cleanly");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "worker shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info("taskflow worker started");
