import { Job } from "@prisma/client";
import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export interface JobPayload {
  jobId: string;
}

export const QUEUE_NAME = "taskflow-jobs";

export const jobQueue = new Queue<JobPayload>(QUEUE_NAME, {
  connection: redisConnection,
});

function jobOptions(priority: number, maxAttempts: number) {
  return {
    priority, // BullMQ convention: lower number = higher priority
    attempts: maxAttempts,
    backoff: { type: "exponential" as const, delay: 2000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
}

function onceQueueJobId(jobId: string) {
  // BullMQ reserves ':' as an internal key separator, so custom ids use '-'.
  return `once-${jobId}`;
}

function recurringSchedulerId(jobId: string) {
  return `recurring-${jobId}`;
}

/** Enqueue a one-off job. `delayMs` defers the first attempt. */
export async function enqueueOnceJob(
  jobId: string,
  opts: { delayMs?: number; priority: number; maxAttempts: number }
) {
  await jobQueue.add(
    "run",
    { jobId },
    {
      // A deterministic BullMQ id makes re-enqueue attempts safe: if the API
      // retries after an ambiguous Redis/network failure, BullMQ won't create
      // a second copy of the same one-off job while the original still exists.
      jobId: onceQueueJobId(jobId),
      delay: opts.delayMs,
      ...jobOptions(opts.priority, opts.maxAttempts),
    }
  );
}

/**
 * Register (or update) a recurring job using BullMQ's Job Scheduler API —
 * the modern replacement for the older `repeat` option. Re-calling this with
 * the same schedulerId updates the existing schedule instead of duplicating it.
 */
export async function upsertRecurringJob(
  jobId: string,
  opts: { cronExpression: string; timezone: string; priority: number; maxAttempts: number }
) {
  await jobQueue.upsertJobScheduler(
    recurringSchedulerId(jobId),
    { pattern: opts.cronExpression, tz: opts.timezone },
    {
      name: "run",
      data: { jobId },
      opts: jobOptions(opts.priority, opts.maxAttempts),
    }
  );
}

/**
 * Make Redis reflect a durable SCHEDULED job definition.
 *
 * This operation is intentionally idempotent. One-off jobs use deterministic
 * BullMQ ids and recurring jobs use `upsertJobScheduler`, so callers can use
 * this both immediately after a Postgres insert and later during recovery.
 */
export async function ensureJobScheduled(job: Job) {
  if (job.status !== "SCHEDULED") return;

  if (job.scheduleType === "ONCE") {
    const runAt = job.runAt ?? new Date();
    const delayMs = Math.max(0, runAt.getTime() - Date.now());
    await enqueueOnceJob(job.id, {
      delayMs,
      priority: job.priority,
      maxAttempts: job.maxAttempts,
    });
    return;
  }

  if (!job.cronExpression) {
    throw new Error(`Recurring job ${job.id} is missing cronExpression`);
  }

  await upsertRecurringJob(job.id, {
    cronExpression: job.cronExpression,
    timezone: job.timezone,
    priority: job.priority,
    maxAttempts: job.maxAttempts,
  });
}

export async function removeRecurringJob(jobId: string) {
  await jobQueue.removeJobScheduler(recurringSchedulerId(jobId));
}

/** Cancel a still-pending one-off job (no-op if it already started running). */
export async function cancelOnceJob(jobId: string) {
  const job = await jobQueue.getJob(onceQueueJobId(jobId));
  if (job) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
      return true;
    }
  }
  return false;
}

/** Fetch the next scheduled run time for a recurring job's scheduler, if any. */
export async function getNextRecurringRun(jobId: string): Promise<Date | null> {
  const schedulers = await jobQueue.getJobSchedulers();
  const match = schedulers.find((s) => s.id === recurringSchedulerId(jobId));
  return match?.next ? new Date(match.next) : null;
}
