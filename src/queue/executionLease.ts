import { JobExecution } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { logger } from "../lib/logger";

export class ExecutionLeaseLostError extends Error {
  constructor(executionId: string) {
    super(`Execution lease '${executionId}' is no longer owned by this worker`);
    this.name = "ExecutionLeaseLostError";
  }
}

export function startExecutionHeartbeat(executionId: string) {
  let leaseLost = false;
  let heartbeatInFlight = false;

  const timer = setInterval(() => {
    if (heartbeatInFlight || leaseLost) return;
    heartbeatInFlight = true;
    void prisma.jobExecution
      .updateMany({
        where: { id: executionId, status: "RUNNING" },
        data: { heartbeatAt: new Date() },
      })
      .then((updated) => {
        if (updated.count === 0) {
          leaseLost = true;
          clearInterval(timer);
          logger.warn({ executionId }, "execution heartbeat lease was lost");
        }
      })
      .catch((error) => {
        logger.warn({ err: error, executionId }, "failed to refresh execution heartbeat");
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, config.EXECUTION_HEARTBEAT_INTERVAL_MS);

  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
    assertOwned() {
      if (leaseLost) throw new ExecutionLeaseLostError(executionId);
    },
  };
}

export async function finishExecution(
  executionId: string,
  data: Pick<JobExecution, "status" | "finishedAt" | "durationMs"> & {
    result?: JobExecution["result"];
    error?: string | null;
  }
) {
  const updated = await prisma.jobExecution.updateMany({
    where: { id: executionId, status: "RUNNING" },
    data,
  });

  if (updated.count === 0) throw new ExecutionLeaseLostError(executionId);

  const execution = await prisma.jobExecution.findUnique({ where: { id: executionId } });
  if (!execution) throw new ExecutionLeaseLostError(executionId);
  return execution;
}
