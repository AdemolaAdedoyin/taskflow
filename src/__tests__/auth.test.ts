import { describe, expect, it, vi } from "vitest";
import { requireAuth } from "../middleware/auth";

function runAuth(authorization?: string) {
  const req = { headers: { authorization } } as any;
  const res = {} as any;
  const next = vi.fn();
  requireAuth(req, res, next);
  return next;
}

describe("API key authentication", () => {
  it("accepts the configured bearer token", () => {
    const next = runAuth("Bearer test-key");
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects missing or incorrect credentials", () => {
    for (const authorization of [undefined, "Bearer wrong-key", "Basic test-key"]) {
      const next = runAuth(authorization);
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
    }
  });
});
