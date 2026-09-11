import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
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

const createSchema = z.object({
  type: z.string().min(1),
  payload: z.unknown(),
  schedule: scheduleSchema,
  priority: z.number().int().min(0).max(10).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

jobRouter.post("/", async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const job = await jobService.createJob(parsed.data);
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

jobRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const scheduleType = typeof req.query.scheduleType === "string" ? req.query.scheduleType : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(await jobService.listJobs({ status, type, scheduleType, limit }));
  } catch (err) {
    next(err);
  }
});

jobRouter.get("/:id", async (req, res, next) => {
  try {
    res.json(await jobService.getJob(req.params.id));
  } catch (err) {
    next(err);
  }
});

jobRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    res.json(await jobService.cancelJob(req.params.id));
  } catch (err) {
    next(err);
  }
});
