import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "true";
const integration = runIntegration ? describe : describe.skip;

integration("Postgres + Redis runtime integration", () => {
  let prisma: any;
  let jobQueue: any;
  let closeQueueResources: () => Promise<void>;
  let server: any;
  let baseUrl = "";

  beforeAll(async () => {
    const [{ createApp }, db, queue] = await Promise.all([
      import("../../app"),
      import("../../db"),
      import("../../queue/jobQueue"),
    ]);

    prisma = db.prisma;
    jobQueue = queue.jobQueue;
    closeQueueResources = queue.closeQueueResources;

    await jobQueue.obliterate({ force: true });
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
    if (jobQueue) await jobQueue.obliterate({ force: true });
    if (prisma) {
      await prisma.jobExecution.deleteMany();
      await prisma.job.deleteMany();
    }
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

  it("exposes authenticated queue and durable-job operational counts", async () => {
    const response = await fetch(`${baseUrl}/v1/operations/overview`, {
      headers: { authorization: `Bearer ${process.env.TASKFLOW_API_KEY}` },
    });

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.jobs.SCHEDULED).toBeGreaterThanOrEqual(1);
    expect(body.queue.delayed).toBeGreaterThanOrEqual(1);
    expect(body.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
