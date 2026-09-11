import "dotenv/config";
import { z } from "zod";
import { parseHandlerConcurrencyLimits, parseHandlerRateLimits } from "./lib/handlerLimitsConfig";

const commaSeparated = z
  .string()
  .default("")
  .transform((value) => value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  LOG_LEVEL: z.string().default("info"),
  JOB_CONCURRENCY: z.coerce.number().int().positive().default(10),
  JOB_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HANDLER_CONCURRENCY_LIMITS: z.string().default(""),
  HANDLER_RATE_LIMITS: z.string().default(""),
  HANDLER_LIMIT_RETRY_DELAY_MS: z.coerce.number().int().positive().default(250),
  HANDLER_PERMIT_TTL_MS: z.coerce.number().int().min(5_000).default(60_000),
  TASKFLOW_API_KEY: z.string().min(1, "TASKFLOW_API_KEY is required"),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
  HTTP_ALLOWED_HOSTS: commaSeparated,
  CALLBACK_ALLOWED_HOSTS: commaSeparated,
  CALLBACK_SIGNING_SECRET: z.string().default("dev-callback-signing-secret"),
  CALLBACK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  CALLBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  CALLBACK_CONCURRENCY: z.coerce.number().int().positive().default(5),
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

if (
  parsed.data.NODE_ENV === "production" &&
  parsed.data.CALLBACK_ALLOWED_HOSTS.length > 0 &&
  parsed.data.CALLBACK_SIGNING_SECRET.length < 32
) {
  console.error("Invalid environment configuration:");
  console.error({
    CALLBACK_SIGNING_SECRET: ["CALLBACK_SIGNING_SECRET must be at least 32 characters when callbacks are enabled in production"],
  });
  process.exit(1);
}

let handlerConcurrencyLimits: Record<string, number>;
let handlerRateLimits: Record<string, { max: number; windowMs: number }>;
try {
  handlerConcurrencyLimits = parseHandlerConcurrencyLimits(parsed.data.HANDLER_CONCURRENCY_LIMITS);
  handlerRateLimits = parseHandlerRateLimits(parsed.data.HANDLER_RATE_LIMITS);
} catch (error: any) {
  console.error("Invalid environment configuration:");
  console.error({ HANDLER_LIMITS: [error?.message ?? "Invalid handler limit configuration"] });
  process.exit(1);
}

export const config = {
  ...parsed.data,
  HANDLER_CONCURRENCY_LIMITS: handlerConcurrencyLimits,
  HANDLER_RATE_LIMITS: handlerRateLimits,
};
