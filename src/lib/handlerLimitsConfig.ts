export interface HandlerRateLimit {
  max: number;
  windowMs: number;
}

export function parseHandlerConcurrencyLimits(value: string): Record<string, number> {
  if (!value.trim()) return {};

  const limits: Record<string, number> = {};
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.lastIndexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`Invalid HANDLER_CONCURRENCY_LIMITS entry '${entry}'. Use handler:limit.`);
    }

    const handler = entry.slice(0, separator).trim();
    const limit = Number(entry.slice(separator + 1));
    if (!handler || !Number.isInteger(limit) || limit < 1) {
      throw new Error(`Invalid HANDLER_CONCURRENCY_LIMITS entry '${entry}'. Limit must be a positive integer.`);
    }
    if (limits[handler] !== undefined) {
      throw new Error(`Duplicate HANDLER_CONCURRENCY_LIMITS entry for '${handler}'.`);
    }
    limits[handler] = limit;
  }
  return limits;
}

export function parseHandlerRateLimits(value: string): Record<string, HandlerRateLimit> {
  if (!value.trim()) return {};

  const limits: Record<string, HandlerRateLimit> = {};
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.lastIndexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`Invalid HANDLER_RATE_LIMITS entry '${entry}'. Use handler:max/windowMs.`);
    }

    const handler = entry.slice(0, separator).trim();
    const [rawMax, rawWindowMs, extra] = entry.slice(separator + 1).split("/");
    const max = Number(rawMax);
    const windowMs = Number(rawWindowMs);
    if (
      !handler ||
      extra !== undefined ||
      !Number.isInteger(max) ||
      max < 1 ||
      !Number.isInteger(windowMs) ||
      windowMs < 1
    ) {
      throw new Error(`Invalid HANDLER_RATE_LIMITS entry '${entry}'. max and windowMs must be positive integers.`);
    }
    if (limits[handler] !== undefined) {
      throw new Error(`Duplicate HANDLER_RATE_LIMITS entry for '${handler}'.`);
    }
    limits[handler] = { max, windowMs };
  }
  return limits;
}
