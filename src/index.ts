import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./db";
import { closeQueueResources } from "./queue/jobQueue";
import { reconcileScheduledJobs } from "./queue/reconcile";

const app = createApp();
let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

async function bootstrap() {
  try {
    await reconcileScheduledJobs();
  } catch (error) {
    // Reconciliation is a recovery mechanism, not a reason to make the HTTP
    // API unavailable. Individual create requests still surface Redis errors,
    // and another restart/retry can repair durable SCHEDULED jobs later.
    logger.error({ err: error }, "startup queue reconciliation failed");
  }

  server = app.listen(config.PORT, () => {
    logger.info(`taskflow API listening on :${config.PORT} (docs at /docs)`);
  });
}

async function closeDependencies() {
  await Promise.allSettled([closeQueueResources(), prisma.$disconnect()]);
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
