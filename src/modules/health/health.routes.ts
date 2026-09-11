import { Router } from "express";
import { prisma } from "../../db";
import { redisConnection } from "../../queue/connection";

export const healthRouter = Router();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("health check timed out")), timeoutMs);
      timeout.unref();
    }),
  ]);
}

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/ready", async (_req, res) => {
  const [postgres, redis] = await Promise.allSettled([
    withTimeout(prisma.$queryRaw`SELECT 1`, 2_000),
    withTimeout(redisConnection.ping(), 2_000),
  ]);

  const checks = {
    postgres: postgres.status === "fulfilled" ? "ok" : "failed",
    redis: redis.status === "fulfilled" ? "ok" : "failed",
  } as const;
  const ready = checks.postgres === "ok" && checks.redis === "ok";

  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});
