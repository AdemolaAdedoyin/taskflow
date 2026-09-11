import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./db";
import { closeCallbackQueueResources } from "./queue/callbackQueue";
import { closeQueueResources } from "./queue/jobQueue";
import { reconcilePendingCallbacks, reconcileScheduledJobs } from "./queue/reconcile";

const app = createApp();
let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

async function bootstrap() {
  try {
    await Promise.all([reconcileScheduledJobs(), reconcilePendingCallbacks()]);
  } catch (error) {
    // Reconciliation is a recovery mechanism, not a reason to make the HTTP
    // API unavailable. Durable rows remain available for another restart/retry.
    logger.error({ err: error }, "startup queue reconciliation failed");
  }

  server = app.listen(config.PORT, () => {
    logger.info(`taskflow API listening on :${config.PORT} (docs at /docs)`);
  });
}

async function closeDependencies() {
  // Both queues share one IORedis client. Close queue wrappers first, then let
  // closeQueueResources terminate the shared connection.
  await closeCallbackQueueResources().catch(() => undefined);
  await closeQueueResources().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down gracefully`);

  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();

  if (!server) {
    await closeDependencies();
    clearTimeout(forceExit);
    process.exit(0);
  }

  server.close(async () => {
    await closeDependencies();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void bootstrap();
