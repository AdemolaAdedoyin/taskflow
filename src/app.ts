import { randomUUID } from "node:crypto";
import { readFileSync } from "fs";
import { join } from "path";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { config } from "./config";
import { logger } from "./lib/logger";
import { assertApiAuthConfiguration, requireAuth } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { authRouter } from "./modules/auth/auth.routes";
import { healthRouter } from "./modules/health/health.routes";
import { jobRouter } from "./modules/jobs/job.routes";
import { metricsRouter } from "./modules/metrics/metrics.routes";
import { operationsRouter } from "./modules/operations/operations.routes";

function requestIdFromHeader(value: string | string[] | undefined) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : undefined;
}

export function createApp() {
  assertApiAuthConfiguration();
  const app = express();

  if (config.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", config.TRUST_PROXY_HOPS);
  }

  const allowedOrigins = new Set(config.CORS_ORIGINS);
  app.use(
    cors({
      origin(origin, callback) {
        // Requests without Origin are server-to-server/same-origin and do not
        // need CORS permission. Cross-origin browser access is allowlisted.
        if (!origin) return callback(null, true);
        return callback(null, allowedOrigins.has(origin));
      },
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const requestId = requestIdFromHeader(req.headers["x-request-id"]) ?? randomUUID();
        res.setHeader("x-request-id", requestId);
        return requestId;
      },
    })
  );

  // Keep the original lightweight endpoint for compatibility while exposing
  // explicit liveness/readiness probes for orchestrators and uptime checks.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/health", healthRouter);

  const openapiDocument = YAML.parse(readFileSync(join(__dirname, "..", "openapi.yaml"), "utf-8"));
  app.get("/openapi.json", (_req, res) => res.json(openapiDocument));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

  // Prometheus-compatible metrics stay outside the normal API rate limiter so
  // a trusted scraper can poll on a fixed cadence. They still require a named
  // client with operations.read permission.
  app.use("/metrics", requireAuth, metricsRouter);

  // Rate-limit before auth so invalid credentials cannot bypass abuse controls.
  // Once authenticated, every /v1 route receives a client identity and scopes.
  app.use(
    "/v1",
    rateLimit({
      windowMs: config.API_RATE_LIMIT_WINDOW_MS,
      limit: config.API_RATE_LIMIT_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    requireAuth
  );
  app.use("/v1/auth", authRouter);
  app.use("/v1/jobs", jobRouter);
  app.use("/v1/operations", operationsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);

  return app;
}
