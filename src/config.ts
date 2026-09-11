import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  LOG_LEVEL: z.string().default("info"),
  JOB_CONCURRENCY: z.coerce.number().int().positive().default(10),
  JOB_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TASKFLOW_API_KEY: z.string().min(1, "TASKFLOW_API_KEY is required"),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
  API_RATE_LIMIT_REQUESTS: z.coerce.number().int().positive().default(600),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === "production" && parsed.data.TASKFLOW_API_KEY.length < 32) {
  console.error("Invalid environment configuration:");
  console.error({ TASKFLOW_API_KEY: ["TASKFLOW_API_KEY must be at least 32 characters in production"] });
  process.exit(1);
}

export const config = parsed.data;
