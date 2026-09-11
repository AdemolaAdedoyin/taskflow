import { createHash, timingSafeEqual } from "node:crypto";
import { RequestHandler } from "express";
import { UnauthorizedError } from "../lib/errors";
import { config } from "../config";

function secureTokenEquals(candidate: string, expected: string) {
  // Hash both values first so timingSafeEqual always compares equal-length
  // buffers and does not leak token length through an early string mismatch.
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

// Taskflow is a single internal service (an internal task-scheduling API, not
// a multi-tenant product), so auth is a single shared API key rather than
// per-tenant lookups.
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");

  if (!token || scheme?.toLowerCase() !== "bearer" || !secureTokenEquals(token, config.TASKFLOW_API_KEY)) {
    next(new UnauthorizedError());
    return;
  }

  next();
};
