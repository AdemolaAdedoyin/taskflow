import { Router } from "express";
import { config } from "../../config";
import { prisma } from "../../db";
import { requireScope } from "../../middleware/auth";
import { callbackQueue } from "../../queue/callbackQueue";
import { jobQueue } from "../../queue/jobQueue";

export const operationsRouter = Router();

operationsRouter.get("/overview", requireScope("operations.read"), async (_req, res, next) => {
  try {
    const [jobQueueCounts, callbackQueueCounts, groupedJobs, groupedCallbacks] = await Promise.all([
      jobQueue.getJobCounts("waiting", "active", "delayed", "completed", "failed", "paused"),
      callbackQueue.getJobCounts("waiting", "active", "delayed", "completed", "failed", "paused"),
      prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.callbackDelivery.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    const jobsByStatus = Object.fromEntries(groupedJobs.map((entry) => [entry.status, entry._count._all]));
    const callbacksByStatus = Object.fromEntries(
      groupedCallbacks.map((entry) => [entry.status, entry._count._all])
    );

    res.json({
      timestamp: new Date().toISOString(),
      process: { uptimeSeconds: Math.round(process.uptime()) },
      queue: jobQueueCounts,
      callbacks: {
        queue: callbackQueueCounts,
        deliveries: callbacksByStatus,
      },
      handlerLimits: {
        concurrency: config.HANDLER_CONCURRENCY_LIMITS,
        rate: config.HANDLER_RATE_LIMITS,
      },
      jobs: jobsByStatus,
    });
  } catch (error) {
    next(error);
  }
});
