import { Router } from "express";
import { prisma } from "../../db";
import { jobQueue } from "../../queue/jobQueue";
import { requireAuth } from "../../middleware/auth";

export const operationsRouter = Router();

operationsRouter.get("/overview", requireAuth, async (_req, res, next) => {
  try {
    const [queueCounts, groupedJobs] = await Promise.all([
      jobQueue.getJobCounts("waiting", "active", "delayed", "completed", "failed", "paused"),
      prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    const jobsByStatus = Object.fromEntries(groupedJobs.map((entry) => [entry.status, entry._count._all]));

    res.json({
      timestamp: new Date().toISOString(),
      process: { uptimeSeconds: Math.round(process.uptime()) },
      queue: queueCounts,
      jobs: jobsByStatus,
    });
  } catch (error) {
    next(error);
  }
});
