import { createHash } from "node:crypto";
import { ExecutionStatus, Job, JobStatus, ScheduleType } from "@prisma/client";
import { prisma } from "../../db";
import { NotFoundError, ConflictError, AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { isValidCronExpression, nextRunFromCron } from "../../lib/cron";
import { assertCallbackConfiguredUrl } from "../../queue/callbackDelivery";
import { ensureJobScheduled, removeRecurringJob, cancelOnceJob } from "../../queue/jobQueue";
import { getHandler } from "../../queue/handlers";
import { CreateJobInput } from "./job.types";

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function idempotencyFingerprint(input: CreateJobInput, priority: number, maxAttempts: number) {
  const schedule =
    input.schedule.type === "once"
      ? { type: "once", runAt: input.schedule.runAt ?? null }
      : {
          type: "recurring",
          cron: input.schedule.cron,
          timezone: input.schedule.timezone ?? "UTC",
        };

  const normalized = canonicalize({
    type: input.type,
    payload: input.payload,
    schedule,
    priority,
    maxAttempts,
    callbackUrl: input.callbackUrl ?? null,
  });

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function returnExistingJob(existing: Job, fingerprint: string) {
  // Rows created before request fingerprints were introduced remain compatible,
  // but all new idempotency keys are bound to one normalized job definition.
  if (existing.idempotencyFingerprint && existing.idempotencyFingerprint !== fingerprint) {
    throw new ConflictError("Idempotency key was already used with a different job definition");
  }

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

  if (input.callbackUrl) {
    try {
      assertCallbackConfiguredUrl(input.callbackUrl);
    } catch (error: any) {
      throw new AppError(error?.message ?? "callbackUrl is not allowed", 422, "VALIDATION_ERROR");
    }
  }

  const priority = input.priority ?? 0;
  const maxAttempts = input.maxAttempts ?? 5;
  const fingerprint = idempotencyFingerprint(input, priority, maxAttempts);

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
      idempotencyFingerprint: input.idempotencyKey ? fingerprint : undefined,
      callbackUrl: input.callbackUrl,
      nextRunAt: runAt,
    };
  } else {
    const timezone = input.schedule.timezone ?? "UTC";
    if (!isValidCronExpression(input.schedule.cron, timezone)) {
      throw new AppError(
        `'${input.schedule.cron}' with timezone '${timezone}' is not a valid recurring schedule`,
        422,
        "VALIDATION_ERROR"
      );
    }

    data = {
      type: input.type,
      payload: input.payload as any,
      scheduleType: "RECURRING" as const,
      cronExpression: input.schedule.cron,
      timezone,
      priority,
      maxAttempts,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: input.idempotencyKey ? fingerprint : undefined,
      callbackUrl: input.callbackUrl,
      nextRunAt: nextRunFromCron(input.schedule.cron, timezone),
    };
  }

  if (input.idempotencyKey) {
    const existing = await prisma.job.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      return returnExistingJob(existing, fingerprint);
    }
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
      if (winner) return returnExistingJob(winner, fingerprint);
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

type ExecutionCursor = {
  startedAt: Date;
  id: string;
};

function encodeExecutionCursor(cursor: ExecutionCursor) {
  return Buffer.from(
    JSON.stringify({ startedAt: cursor.startedAt.toISOString(), id: cursor.id }),
    "utf8"
  ).toString("base64url");
}

function decodeExecutionCursor(value: string): ExecutionCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      startedAt?: unknown;
      id?: unknown;
    };
    if (typeof decoded.startedAt !== "string" || typeof decoded.id !== "string" || decoded.id.length === 0) {
      throw new Error("invalid cursor shape");
    }
    const startedAt = new Date(decoded.startedAt);
    if (Number.isNaN(startedAt.getTime())) throw new Error("invalid cursor timestamp");
    return { startedAt, id: decoded.id };
  } catch {
    throw new AppError("cursor is invalid", 422, "VALIDATION_ERROR");
  }
}

export async function listJobExecutions(
  id: string,
  options: { status?: ExecutionStatus; limit: number; cursor?: string }
) {
  const job = await prisma.job.findUnique({ where: { id }, select: { id: true } });
  if (!job) throw new NotFoundError("Job", id);

  const cursor = options.cursor ? decodeExecutionCursor(options.cursor) : undefined;
  const rows = await prisma.jobExecution.findMany({
    where: {
      jobId: id,
      status: options.status,
      ...(cursor
        ? {
            OR: [
              { startedAt: { lt: cursor.startedAt } },
              { startedAt: cursor.startedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
  });

  const hasMore = rows.length > options.limit;
  const data = hasMore ? rows.slice(0, options.limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    pageInfo: {
      nextCursor: hasMore && last ? encodeExecutionCursor({ startedAt: last.startedAt, id: last.id }) : null,
      hasMore,
    },
  };
}

export async function cancelJob(id: string) {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) throw new NotFoundError("Job", id);
  if (job.status === "CANCELLED" || job.status === "SUCCEEDED" || job.status === "FAILED") {
    throw new ConflictError(`Job is already in a terminal state (${job.status})`);
  }
  if (job.status === "RUNNING") {
    // Handlers are arbitrary user code and cannot be safely pre-empted. Refuse
    // to claim cancellation succeeded while a worker may still be executing it.
    throw new ConflictError("Job is currently running and cannot be cancelled safely");
  }

  const cancelled = await prisma.job.updateMany({
    where: { id, status: "SCHEDULED" },
    data: { status: "CANCELLED", nextRunAt: null },
  });

  if (cancelled.count === 0) {
    const latest = await prisma.job.findUnique({ where: { id } });
    throw new ConflictError(`Job can no longer be cancelled (${latest?.status ?? "unknown state"})`);
  }

  // Postgres changes first: if Redis cleanup fails or races with a worker, the
  // durable CANCELLED state still prevents the queued firing from executing.
  try {
    if (job.scheduleType === "ONCE") {
      await cancelOnceJob(id);
    } else {
      await removeRecurringJob(id);
    }
  } catch (error) {
    logger.warn({ err: error, jobId: id }, "queue cleanup failed after durable cancellation");
  }

  const result = await prisma.job.findUnique({ where: { id } });
  if (!result) throw new NotFoundError("Job", id);
  return result;
}
