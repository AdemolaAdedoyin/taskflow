import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "true";
const integration = runIntegration ? describe : describe.skip;

integration("Postgres + Redis runtime integration", () => {
  let prisma: any;
  let jobQueue: any;
  let callbackQueue: any;
  let closeQueueResources: () => Promise<void>;
  let closeCallbackQueueResources: () => Promise<void>;
  let scheduleCompletionCallback: (job: any, execution: any) => Promise<any>;
  let server: any;
  let baseUrl = "";

  beforeAll(async () => {
    const [{ createApp }, db, queue, callbackQueueModule, callbackDelivery] = await Promise.all([
      import("../../app"),
      import("../../db"),
      import("../../queue/jobQueue"),
      import("../../queue/callbackQueue"),
      import("../../queue/callbackDelivery"),
    ]);

    prisma = db.prisma;
    jobQueue = queue.jobQueue;
    callbackQueue = callbackQueueModule.callbackQueue;
    closeQueueResources = queue.closeQueueResources;
    closeCallbackQueueResources = callbackQueueModule.closeCallbackQueueResources;
    scheduleCompletionCallback = callbackDelivery.scheduleCompletionCallback;

    await Promise.all([
      jobQueue.obliterate({ force: true }),
      callbackQueue.obliterate({ force: true }),
    ]);
    await prisma.callbackDelivery.deleteMany();
    await prisma.jobExecution.deleteMany();
    await prisma.job.deleteMany();

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      });
    }
    if (jobQueue && callbackQueue) {
      await Promise.all([
        jobQueue.obliterate({ force: true }),
        callbackQueue.obliterate({ force: true }),
      ]);
    }
    if (prisma) {
      await prisma.callbackDelivery.deleteMany();
      await prisma.jobExecution.deleteMany();
      await prisma.job.deleteMany();
    }
    if (closeCallbackQueueResources) await closeCallbackQueueResources();
    if (closeQueueResources) await closeQueueResources();
    if (prisma) await prisma.$disconnect();
  });

  it("reports readiness only when Postgres and Redis are reachable and preserves request ids", async () => {
    const response = await fetch(`${baseUrl}/health/ready`, {
      headers: { "x-request-id": "integration-ready-1" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("integration-ready-1");
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { postgres: "ok", redis: "ok" },
    });
  });

  it("creates an idempotent API job that is durably stored and projected into BullMQ", async () => {
    const runAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const body = {
      type: "log_message",
      payload: { message: "integration" },
      schedule: { type: "once", runAt },
      idempotencyKey: "integration-job-1",
    };

    const create = () =>
      fetch(`${baseUrl}/v1/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.TASKFLOW_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const firstResponse = await create();
    expect(firstResponse.status).toBe(201);
    const first: any = await firstResponse.json();

    const secondResponse = await create();
    expect(secondResponse.status).toBe(201);
    const second: any = await secondResponse.json();

    expect(second.id).toBe(first.id);
    expect(await prisma.job.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);

    const queued = await jobQueue.getJob(`once-${first.id}`);
    expect(queued?.data).toEqual({ jobId: first.id });
  });

  it("persists completion callbacks before projecting them into the callback queue", async () => {
    const runAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const response = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.TASKFLOW_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "log_message",
        payload: { message: "callback" },
        schedule: { type: "once", runAt },
        idempotencyKey: "integration-callback-job",
        callbackUrl: "https://example.com/taskflow-callback",
      }),
    });

    expect(response.status).toBe(201);
    const created: any = await response.json();
    expect(created.callbackUrl).toBe("https://example.com/taskflow-callback");

    const job = await prisma.job.findUnique({ where: { id: created.id } });
    const execution = await prisma.jobExecution.create({
      data: {
        jobId: created.id,
        attemptNumber: 1,
        status: "SUCCEEDED",
        finishedAt: new Date(),
        durationMs: 25,
        result: { ok: true },
      },
    });

    const delivery = await scheduleCompletionCallback(job, execution);
    expect(delivery.status).toBe("PENDING");
    expect(await prisma.callbackDelivery.count({ where: { executionId: execution.id } })).toBe(1);

    const queued = await callbackQueue.getJob(`callback-${delivery.id}`);
    expect(queued?.data).toEqual({ deliveryId: delivery.id });
  });

  it("paginates durable execution history without duplicates", async () => {
    const job = await prisma.job.create({
      data: {
        type: "log_message",
        payload: { message: "history" },
        scheduleType: "ONCE",
        runAt: new Date(),
      },
    });

    const now = Date.now();
    for (let index = 0; index < 3; index += 1) {
      await prisma.jobExecution.create({
        data: {
          jobId: job.id,
          attemptNumber: index + 1,
          status: index === 0 ? "SUCCEEDED" : "FAILED",
          startedAt: new Date(now - index * 1_000),
          finishedAt: new Date(now - index * 1_000 + 100),
          durationMs: 100,
        },
      });
    }

    const headers = { authorization: `Bearer ${process.env.TASKFLOW_API_KEY}` };
    const firstResponse = await fetch(`${baseUrl}/v1/jobs/${job.id}/executions?limit=2`, { headers });
    expect(firstResponse.status).toBe(200);
    const firstPage: any = await firstResponse.json();

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.pageInfo.nextCursor).toEqual(expect.any(String));

    const secondResponse = await fetch(
      `${baseUrl}/v1/jobs/${job.id}/executions?limit=2&cursor=${encodeURIComponent(firstPage.pageInfo.nextCursor)}`,
      { headers }
    );
    expect(secondResponse.status).toBe(200);
    const secondPage: any = await secondResponse.json();

    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    expect(new Set([...firstPage.data, ...secondPage.data].map((execution: any) => execution.id)).size).toBe(3);
  });

  it("exposes authenticated queue, callback, and durable-job operational counts", async () => {
    const response = await fetch(`${baseUrl}/v1/operations/overview`, {
      headers: { authorization: `Bearer ${process.env.TASKFLOW_API_KEY}` },
    });

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.jobs.SCHEDULED).toBeGreaterThanOrEqual(1);
    expect(body.queue.delayed).toBeGreaterThanOrEqual(1);
    expect(body.callbacks.deliveries.PENDING).toBeGreaterThanOrEqual(1);
    expect(body.callbacks.queue.waiting).toBeGreaterThanOrEqual(1);
    expect(body.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
