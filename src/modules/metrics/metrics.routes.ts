import { Router } from "express";
import { prisma } from "../../db";
import { callbackQueue } from "../../queue/callbackQueue";
import { jobQueue } from "../../queue/jobQueue";
import { requireScope } from "../../middleware/auth";

export const metricsRouter = Router();

const queueStates = ["waiting", "active", "delayed", "completed", "failed", "paused"] as const;

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function metric(name: string, value: number, labels: Record<string, string> = {}) {
  const encodedLabels = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`)
    .join(",");
  return `${name}${encodedLabels ? `{${encodedLabels}}` : ""} ${value}`;
}

metricsRouter.get("/", requireScope("operations.read"), async (_req, res, next) => {
  try {
    const [jobQueueCounts, callbackQueueCounts, groupedJobs, groupedCallbacks] = await Promise.all([
      jobQueue.getJobCounts(...queueStates),
      callbackQueue.getJobCounts(...queueStates),
      prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.callbackDelivery.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    const lines = [
      "# HELP taskflow_process_uptime_seconds Process uptime in seconds.",
      "# TYPE taskflow_process_uptime_seconds gauge",
      metric("taskflow_process_uptime_seconds", Math.round(process.uptime())),
      "# HELP taskflow_jobs Durable jobs by status.",
      "# TYPE taskflow_jobs gauge",
      ...groupedJobs.map((entry) => metric("taskflow_jobs", entry._count._all, { status: entry.status })),
      "# HELP taskflow_job_queue_jobs BullMQ business jobs by queue state.",
      "# TYPE taskflow_job_queue_jobs gauge",
      ...queueStates.map((state) => metric("taskflow_job_queue_jobs", jobQueueCounts[state] ?? 0, { state })),
      "# HELP taskflow_callback_deliveries Durable callback deliveries by status.",
      "# TYPE taskflow_callback_deliveries gauge",
      ...groupedCallbacks.map((entry) =>
        metric("taskflow_callback_deliveries", entry._count._all, { status: entry.status })
      ),
      "# HELP taskflow_callback_queue_jobs BullMQ callback jobs by queue state.",
      "# TYPE taskflow_callback_queue_jobs gauge",
      ...queueStates.map((state) =>
        metric("taskflow_callback_queue_jobs", callbackQueueCounts[state] ?? 0, { state })
      ),
      "",
    ];

    res.type("text/plain; version=0.0.4; charset=utf-8").send(lines.join("\n"));
  } catch (error) {
    next(error);
  }
});
