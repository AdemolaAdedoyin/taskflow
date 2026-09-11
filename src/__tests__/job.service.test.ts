import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => {
  const jobs = new Map<string, any>();
  let counter = 0;

  return {
    prisma: {
      job: {
        create: vi.fn(async ({ data }: any) => {
          const id = `job_${++counter}`;
          const record = {
            id,
            status: "SCHEDULED",
            attemptCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastError: null,
            lastRunAt: null,
            ...data,
          };
          jobs.set(id, record);
          return record;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return jobs.get(where.id) ?? null;
          if (where.idempotencyKey) {
            return [...jobs.values()].find((j) => j.idempotencyKey === where.idempotencyKey) ?? null;
          }
          return null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const record = { ...jobs.get(where.id), ...data };
          jobs.set(where.id, record);
          return record;
        }),
        findMany: vi.fn(async () => [...jobs.values()]),
      },
    },
  };
});

vi.mock("../queue/jobQueue", () => ({
  ensureJobScheduled: vi.fn(async () => {}),
  removeRecurringJob: vi.fn(async () => {}),
  cancelOnceJob: vi.fn(async () => true),
}));

import { prisma } from "../db";
import * as jobService from "../modules/jobs/job.service";
import { ensureJobScheduled } from "../queue/jobQueue";

describe("job.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a one-off job and schedules the durable definition", async () => {
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const job = await jobService.createJob({
      type: "log_message",
      payload: { message: "hi" },
      schedule: { type: "once", runAt },
    });

    expect(job.scheduleType).toBe("ONCE");
    expect(ensureJobScheduled).toHaveBeenCalledWith(job);
  });

  it("rejects a job type with no registered handler", async () => {
    await expect(
      jobService.createJob({
        type: "totally_unregistered_type",
        payload: {},
        schedule: { type: "once" },
      })
    ).rejects.toThrow(/No handler registered/);
  });

  it("rejects an invalid cron expression", async () => {
    await expect(
      jobService.createJob({
        type: "log_message",
        payload: {},
        schedule: { type: "recurring", cron: "not a cron" },
      })
    ).rejects.toThrow(/not a valid cron expression/);
  });

  it("creates a recurring job and schedules the durable definition", async () => {
    const job = await jobService.createJob({
      type: "log_message",
      payload: { message: "tick" },
      schedule: { type: "recurring", cron: "0 2 * * *", timezone: "UTC" },
    });

    expect(job.scheduleType).toBe("RECURRING");
    expect(ensureJobScheduled).toHaveBeenCalledWith(job);
  });

  it("repairs queue state when an idempotent retry finds an existing scheduled job", async () => {
    const first = await jobService.createJob({
      type: "log_message",
      payload: { message: "once" },
      schedule: { type: "once" },
      idempotencyKey: "order-42-notify",
    });

    const second = await jobService.createJob({
      type: "log_message",
      payload: { message: "once, again" },
      schedule: { type: "once" },
      idempotencyKey: "order-42-notify",
    });

    expect(second.id).toBe(first.id);
    expect(ensureJobScheduled).toHaveBeenCalledTimes(2);
    expect(prisma.job.create).toHaveBeenCalledTimes(1);
  });

  it("returns and repairs the winning row when concurrent idempotent creates race", async () => {
    const winner = {
      id: "job_winner",
      type: "log_message",
      payload: { message: "winner" },
      scheduleType: "ONCE",
      runAt: new Date(),
      cronExpression: null,
      timezone: "UTC",
      priority: 0,
      maxAttempts: 5,
      attemptCount: 0,
      idempotencyKey: "race-key",
      status: "SCHEDULED",
      lastError: null,
      lastRunAt: null,
      nextRunAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    vi.mocked(prisma.job.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    vi.mocked(prisma.job.create).mockRejectedValueOnce({ code: "P2002" });

    const result = await jobService.createJob({
      type: "log_message",
      payload: { message: "racer" },
      schedule: { type: "once" },
      idempotencyKey: "race-key",
    });

    expect(result).toBe(winner);
    expect(ensureJobScheduled).toHaveBeenCalledWith(winner);
  });
});
