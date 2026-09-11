import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./db";
import { reconcileScheduledJobs } from "./queue/reconcile";

const app = createApp();
let server: ReturnType<typeof app.listen> | undefined;

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

async function shutdown(signal: string) {
  logger.info(`received ${signal}, shutting down gracefully`);

  if (!server) {
    await prisma.$disconnect();
    process.exit(0);
  }

  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

void bootstrap();
