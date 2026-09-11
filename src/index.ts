import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./db";

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(`taskflow API listening on :${config.PORT} (docs at /docs)`);
});

async function shutdown(signal: string) {
  logger.info(`received ${signal}, shutting down gracefully`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
