import { z } from "zod";
import { JobHandler } from "./types";

const payloadSchema = z.object({
  // Fails on every attempt below this number, then succeeds — handy for
  // demonstrating retry/backoff behavior without needing a flaky real endpoint.
  failUntilAttempt: z.number().int().min(1).default(3),
});

export const simulateFailureHandler: JobHandler = async (rawPayload, ctx) => {
  const payload = payloadSchema.parse(rawPayload);
  if (ctx.attemptNumber < payload.failUntilAttempt) {
    throw new Error(`Simulated failure on attempt ${ctx.attemptNumber} of ${payload.failUntilAttempt - 1}`);
  }
  return { succeededOnAttempt: ctx.attemptNumber };
};
