import { z } from "zod";
import { logger } from "../../lib/logger";
import { JobHandler } from "./types";

const payloadSchema = z.object({
  message: z.string(),
  level: z.enum(["info", "warn", "error"]).default("info"),
});

/** Writes a structured log line. Useful for smoke-testing the scheduler without external side effects. */
export const logMessageHandler: JobHandler = async (rawPayload, ctx) => {
  const payload = payloadSchema.parse(rawPayload);
  logger[payload.level]({ jobId: ctx.jobId, attempt: ctx.attemptNumber }, payload.message);
  return { logged: true };
};
