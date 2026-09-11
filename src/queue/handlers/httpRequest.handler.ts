import { z } from "zod";
import { config } from "../../config";
import { readResponseTextLimited } from "../../lib/http";
import { assertSafeHttpUrl } from "../../lib/network";
import { JobHandler } from "./types";

const payloadSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

function assertAllowedOutboundHost(target: URL) {
  const hostname = target.hostname.toLowerCase();
  const allowedHosts = new Set(config.HTTP_ALLOWED_HOSTS);

  if (config.NODE_ENV === "production" && allowedHosts.size === 0) {
    throw new Error("http_request jobs are disabled until HTTP_ALLOWED_HOSTS is configured");
  }

  if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new Error(`HTTP job target hostname '${hostname}' is not in HTTP_ALLOWED_HOSTS`);
  }
}

export const httpRequestHandler: JobHandler = async (rawPayload) => {
  const payload = payloadSchema.parse(rawPayload);
  const target = await assertSafeHttpUrl(payload.url);
  assertAllowedOutboundHost(target);

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

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Request to ${target.toString()} returned a redirect, which Taskflow does not follow`);
    }

    const text = await readResponseTextLimited(res, res.ok ? 2_000 : 300).catch(() => "");
    if (!res.ok) {
      throw new Error(`Request to ${target.toString()} failed with HTTP ${res.status}: ${text}`);
    }
    return { status: res.status, body: text };
  } finally {
    clearTimeout(timeout);
  }
};
