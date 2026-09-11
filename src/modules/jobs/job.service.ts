import { Job, JobStatus, ScheduleType } from "@prisma/client";
import { prisma } from "../../db";
import { NotFoundError, ConflictError, AppError } from "../../lib/errors";
import { isValidCronExpression, nextRunFromCron } from "../../lib/cron";
import { ensureJobScheduled, removeRecurringJob, cancelOnceJob } from "../../queue/jobQueue";
import { getHandler } from "../../queue/handlers";
import { CreateJobInput } from "./job.types";

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

async function returnExistingJob(existing: Job) {
  // A previous request may have committed the durable Job row and then lost
  // its Redis acknowledgement. Re-running the idempotent scheduling operation
  // repairs that gap instead of merely returning a stranded SCHEDULED record.
  await ensureJobScheduled(existing);
  return existing;
}

export async function createJob(input: CreateJobInput) {
  // Fail fast if nothing is registered for this type, rather than accepting
  // a job that will error out on its very first execution.
  getHandler(input.type);

  if (input.idempotencyKey) {
    const existing = await prisma.job.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      return returnExistingJob(existing);
    }
  }

  const priority = input.priority ?? 0;
  const maxAttempts = input.maxAttempts ?? 5;

  let data;
  if (input.schedule.type === "once") {
    const runAt = input.schedule.runAt ? new Date(input.schedule.runAt) : new Date();
    if (Number.isNaN(runAt.getTime())) {
      throw new AppError("runAt must be a valid ISO 8601 date", 422, "VALIDATION_ERROR");
    }

    data = {
      type: input.type,
      payload: input.payload as any,
      scheduleType: "ONCE" as const,
      runAt,
      priority,
      maxAttempts,
      idempotencyKey: input.idempotencyKey,
      nextRunAt: runAt,
    };
  } else {
    if (!isValidCronExpression(input.schedule.cron)) {
      throw new AppError(`'${input.schedule.cron}' is not a valid cron expression`, 422, "VALIDATION_ERROR");
    }

    const timezone = input.schedule.timezone ?? "UTC";
    data = {
      type: input.type,
      payload: input.payload as any,
      scheduleType: "RECURRING" as const,
      cronExpression: input.schedule.cron,
      timezone,
      priority,
      maxAttempts,
      idempotencyKey: input.idempotencyKey,
      nextRunAt: nextRunFromCron(input.schedule.cron, timezone),
    };
  }

  let job: Job;
  try {
    job = await prisma.job.create({ data });
  } catch (error) {
    // The pre-read above is only an optimization. The unique index is the
    // actual concurrency boundary: if two callers race on the same key, the
    // loser reads the winning row and performs the same safe queue repair.
    if (input.idempotencyKey && isUniqueConstraintError(error)) {
      const winner = await prisma.job.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner) return returnExistingJob(winner);
    }
    throw error;
  }

  // Postgres is the source of truth. If Redis is unavailable here, preserve
  // the SCHEDULED row and fail the request. A retry with the same idempotency
  // key, or startup reconciliation, can safely recreate the missing queue item.
  await ensureJobScheduled(job);
  return job;
}

export async function listJobs(options: {
  status?: JobStatus;
  type?: string;
  scheduleType?: ScheduleType;
  limit: number;
}) {
  return prisma.job.findMany({
    where: {
      status: options.status,
      type: options.type,
      scheduleType: options.scheduleType,
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
  });
}

export async function getJob(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    include: { executions: { orderBy: { startedAt: "desc" }, take: 20 } },
  });
  if (!job) throw new NotFoundError("Job", id);
  return job;
}

export async function cancelJob(id: string) {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) throw new NotFoundError("Job", id);
  if (job.status === "CANCELLED" || job.status === "SUCCEEDED" || job.status === "FAILED") {
    throw new ConflictError(`Job is already in a terminal state (${job.status})`);
  }

  if (job.scheduleType === "ONCE") {
    await cancelOnceJob(id);
  } else {
    await removeRecurringJob(id);
  }

  return prisma.job.update({ where: { id }, data: { status: "CANCELLED", nextRunAt: null } });
}
