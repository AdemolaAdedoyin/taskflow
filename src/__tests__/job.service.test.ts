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
  enqueueOnceJob: vi.fn(async () => {}),
  upsertRecurringJob: vi.fn(async () => {}),
  removeRecurringJob: vi.fn(async () => {}),
  cancelOnceJob: vi.fn(async () => true),
}));

import * as jobService from "../modules/jobs/job.service";
import { enqueueOnceJob, upsertRecurringJob } from "../queue/jobQueue";

describe("job.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a one-off job and enqueues it with a computed delay", async () => {
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const job = await jobService.createJob({
      type: "log_message",
      payload: { message: "hi" },
      schedule: { type: "once", runAt },
    });

    expect(job.scheduleType).toBe("ONCE");
    expect(enqueueOnceJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({ priority: 0, maxAttempts: 5 })
    );
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

  it("creates a recurring job and registers a scheduler", async () => {
    const job = await jobService.createJob({
      type: "log_message",
      payload: { message: "tick" },
      schedule: { type: "recurring", cron: "0 2 * * *", timezone: "UTC" },
    });

    expect(job.scheduleType).toBe("RECURRING");
    expect(upsertRecurringJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({ cronExpression: "0 2 * * *", timezone: "UTC" })
    );
  });

  it("returns the existing job instead of creating a duplicate when idempotencyKey matches", async () => {
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
    expect(enqueueOnceJob).toHaveBeenCalledTimes(1); // not called again for the duplicate
  });
});
