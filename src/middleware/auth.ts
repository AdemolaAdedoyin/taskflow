import { RequestHandler } from "express";
import { UnauthorizedError } from "../lib/errors";
import { config } from "../config";

// Taskflow is a single internal service (an internal task-scheduling API, not
// a multi-tenant product), so auth is a single shared API key rather than
// per-tenant lookups.
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token !== config.TASKFLOW_API_KEY) {
    next(new UnauthorizedError());
    return;
  }
  next();
};
