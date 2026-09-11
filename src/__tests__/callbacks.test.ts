import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config } from "../config";
import { assertCallbackConfiguredUrl, buildCallbackBody, signCallbackBody } from "../queue/callbackDelivery";

describe("completion callbacks", () => {
  it("signs the exact callback body with HMAC-SHA256", () => {
    const body = '{"event":"job.execution.succeeded"}';
    const expected = createHmac("sha256", config.CALLBACK_SIGNING_SECRET).update(body).digest("hex");
    expect(signCallbackBody(body)).toBe(`sha256=${expected}`);
  });

  it("builds a callback payload with stable job and execution identifiers", () => {
    const body = JSON.parse(
      buildCallbackBody(
        "delivery-1",
        { id: "job-1", type: "log_message", scheduleType: "ONCE", status: "SUCCEEDED" } as any,
        {
          id: "execution-1",
          attemptNumber: 1,
          status: "SUCCEEDED",
          startedAt: new Date("2026-09-11T20:00:00.000Z"),
          finishedAt: new Date("2026-09-11T20:00:01.000Z"),
          durationMs: 1000,
          result: { ok: true },
          error: null,
        } as any
      )
    );

    expect(body.event).toBe("job.execution.succeeded");
    expect(body.deliveryId).toBe("delivery-1");
    expect(body.job.id).toBe("job-1");
    expect(body.execution.id).toBe("execution-1");
    expect(body.execution.result).toEqual({ ok: true });
  });

  it("rejects unsupported callback protocols and embedded credentials", () => {
    expect(() => assertCallbackConfiguredUrl("ftp://example.com/callback")).toThrow(/http:\/\/ and https:\/\//);
    expect(() => assertCallbackConfiguredUrl("https://user:pass@example.com/callback")).toThrow(/credentials/);
  });
});
