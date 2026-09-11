import { z } from "zod";
import { config } from "../../config";
import { JobHandler } from "./types";

const payloadSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

/**
 * Generic "call this endpoint" handler — the most common real-world use of a
 * job queue: cache warmers, internal service pokes, cleanup callbacks, etc.
 */
export const httpRequestHandler: JobHandler = async (rawPayload) => {
  const payload = payloadSchema.parse(rawPayload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.JOB_DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(payload.url, {
      method: payload.method,
      headers: { "Content-Type": "application/json", ...payload.headers },
      body: payload.body !== undefined ? JSON.stringify(payload.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`Request to ${payload.url} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return { status: res.status, body: text.slice(0, 2000) };
  } finally {
    clearTimeout(timeout);
  }
};
