import { z } from "zod";
import { config } from "../../config";
import { assertSafeHttpUrl } from "../../lib/network";
import { JobHandler } from "./types";

const payloadSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

/**
 * Generic "call this endpoint" handler — useful for cache warmers, callbacks,
 * and service-to-service tasks. User-supplied targets are validated before
 * connection and redirects are disabled so a public URL cannot bounce the
 * worker into a private network.
 */
export const httpRequestHandler: JobHandler = async (rawPayload) => {
  const payload = payloadSchema.parse(rawPayload);
  const target = await assertSafeHttpUrl(payload.url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.JOB_DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(target, {
      method: payload.method,
      headers: { "Content-Type": "application/json", ...payload.headers },
      body: payload.body !== undefined ? JSON.stringify(payload.body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    const text = await res.text().catch(() => "");
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Request to ${target.toString()} returned a redirect, which Taskflow does not follow`);
    }
    if (!res.ok) {
      throw new Error(`Request to ${target.toString()} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return { status: res.status, body: text.slice(0, 2000) };
  } finally {
    clearTimeout(timeout);
  }
};
