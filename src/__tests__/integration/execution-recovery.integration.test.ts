import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "true";
const integration = runIntegration ? describe : describe.skip;

integration("stale execution recovery", () => {
  let prisma: any;
  let recoverStaleExecutions: (jobId?: string) => Promise<{ checked: number; recovered: number }>;
  let createdJobId: string | undefined;

  beforeAll(async () => {
    const [db, lease] = await Promise.all([
      import("../../db"),
      import("../../queue/executionLease"),
    ]);
    prisma = db.prisma;
    recoverStaleExecutions = lease.recoverStaleExecutions;
  });

  afterAll(async () => {
    if (prisma && createdJobId) {
      await prisma.job.delete({ where: { id: createdJobId } }).catch(() => undefined);
    }
  });

  it("marks an abandoned execution failed and makes its job schedulable again", async () => {
    const job = await prisma.job.create({
      data: {
        type: "log_message",
        payload: { message: "recover me" },
        scheduleType: "ONCE",
        runAt: new Date(Date.now() - 60_000),
        status: "RUNNING",
        attemptCount: 1,
      },
    });
    createdJobId = job.id;

    const execution = await prisma.jobExecution.create({
      data: {
        jobId: job.id,
        attemptNumber: 1,
        status: "RUNNING",
        startedAt: new Date(Date.now() - 10 * 60_000),
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    const result = await recoverStaleExecutions(job.id);
    expect(result.recovered).toBe(1);

    const [recoveredJob, recoveredExecution] = await Promise.all([
      prisma.job.findUnique({ where: { id: job.id } }),
      prisma.jobExecution.findUnique({ where: { id: execution.id } }),
    ]);

    expect(recoveredJob.status).toBe("SCHEDULED");
    expect(recoveredExecution.status).toBe("FAILED");
    expect(recoveredExecution.error).toMatch(/heartbeat expired/);
  });
});
