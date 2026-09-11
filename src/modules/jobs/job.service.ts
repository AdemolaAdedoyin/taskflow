import { JobStatus, ScheduleType } from "@prisma/client";
import { prisma } from "../../db";
import { NotFoundError, ConflictError, AppError } from "../../lib/errors";
import { isValidCronExpression, nextRunFromCron } from "../../lib/cron";
import { enqueueOnceJob, upsertRecurringJob, removeRecurringJob, cancelOnceJob } from "../../queue/jobQueue";
import { getHandler } from "../../queue/handlers";
import { CreateJobInput } from "./job.types";

export async function createJob(input: CreateJobInput) {
  // Fail fast if nothing is registered for this type, rather than accepting
  // a job that will error out on its very first execution.
  getHandler(input.type);

  if (input.idempotencyKey) {
    const existing = await prisma.job.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      // Idempotent create: returning the existing job (not an error) lets
      // callers safely retry a "create job" request after a network blip
      // without double-scheduling work.
      return existing;
    }
  }

  const priority = input.priority ?? 0;
  const maxAttempts = input.maxAttempts ?? 5;

  if (input.schedule.type === "once") {
    const runAt = input.schedule.runAt ? new Date(input.schedule.runAt) : new Date();
    if (Number.isNaN(runAt.getTime())) {
      throw new AppError("runAt must be a valid ISO 8601 date", 422, "VALIDATION_ERROR");
    }

    const job = await prisma.job.create({
      data: {
        type: input.type,
        payload: input.payload as any,
        scheduleType: "ONCE",
        runAt,
        priority,
        maxAttempts,
        idempotencyKey: input.idempotencyKey,
        nextRunAt: runAt,
      },
    });

    const delayMs = Math.max(0, runAt.getTime() - Date.now());
    await enqueueOnceJob(job.id, { delayMs, priority, maxAttempts });
    return job;
  }

  // Recurring
  if (!isValidCronExpression(input.schedule.cron)) {
    throw new AppError(`'${input.schedule.cron}' is not a valid cron expression`, 422, "VALIDATION_ERROR");
  }
  const timezone = input.schedule.timezone ?? "UTC";
  const nextRunAt = nextRunFromCron(input.schedule.cron, timezone);

  const job = await prisma.job.create({
    data: {
      type: input.type,
      payload: input.payload as any,
      scheduleType: "RECURRING",
      cronExpression: input.schedule.cron,
      timezone,
      priority,
      maxAttempts,
      idempotencyKey: input.idempotencyKey,
      nextRunAt,
    },
  });

  await upsertRecurringJob(job.id, { cronExpression: input.schedule.cron, timezone, priority, maxAttempts });
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
