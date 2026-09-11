import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import { requireScope } from "../../middleware/auth";
import * as jobService from "./job.service";

export const jobRouter = Router();

const scheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), runAt: z.string().datetime().optional() }),
  z.object({
    type: z.literal("recurring"),
    cron: z.string().min(1),
    timezone: z.string().optional(),
  }),
]);

const createSchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown(),
    schedule: scheduleSchema,
    priority: z.number().int().min(0).max(10).optional(),
    maxAttempts: z.number().int().min(1).max(20).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    callbackUrl: z.string().url().max(2048).optional(),
  })
  // `unknown` intentionally permits any JSON-shaped payload, including null.
  // Presence still matters: omitting payload entirely is a malformed create request.
  .refine((value) => Object.prototype.hasOwnProperty.call(value, "payload"), {
    path: ["payload"],
    message: "Required",
  });

const listSchema = z.object({
  status: z.enum(["SCHEDULED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]).optional(),
  type: z.string().min(1).optional(),
  scheduleType: z.enum(["ONCE", "RECURRING"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const executionListSchema = z.object({
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1024).optional(),
});

function parseJobId(rawId: string | undefined) {
  const parsed = z.string().min(1).safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError({ id: ["A job id is required"] });
  }
  return parsed.data;
}

jobRouter.post("/", requireScope("jobs.write"), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const job = await jobService.createJob({
      type: parsed.data.type,
      payload: parsed.data.payload,
      schedule: parsed.data.schedule,
      priority: parsed.data.priority,
      maxAttempts: parsed.data.maxAttempts,
      idempotencyKey: parsed.data.idempotencyKey,
      callbackUrl: parsed.data.callbackUrl,
    });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

jobRouter.get("/", requireScope("jobs.read"), async (req, res, next) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    res.json(await jobService.listJobs(parsed.data));
  } catch (err) {
    next(err);
  }
});

jobRouter.get("/:id/executions", requireScope("jobs.read"), async (req, res, next) => {
  try {
    const parsed = executionListSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    res.json(await jobService.listJobExecutions(parseJobId(req.params.id), parsed.data));
  } catch (err) {
    next(err);
  }
});

jobRouter.get("/:id", requireScope("jobs.read"), async (req, res, next) => {
  try {
    res.json(await jobService.getJob(parseJobId(req.params.id)));
  } catch (err) {
    next(err);
  }
});

jobRouter.post("/:id/cancel", requireScope("jobs.write"), async (req, res, next) => {
  try {
    res.json(await jobService.cancelJob(parseJobId(req.params.id)));
  } catch (err) {
    next(err);
  }
});
