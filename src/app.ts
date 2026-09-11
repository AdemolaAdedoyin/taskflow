import { readFileSync } from "fs";
import { join } from "path";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { logger } from "./lib/logger";
import { requireAuth } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { jobRouter } from "./modules/jobs/job.routes";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const openapiDocument = YAML.parse(readFileSync(join(__dirname, "..", "openapi.yaml"), "utf-8"));
  app.get("/openapi.json", (_req, res) => res.json(openapiDocument));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

  app.use("/v1/jobs", requireAuth, jobRouter);

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);

  return app;
}
