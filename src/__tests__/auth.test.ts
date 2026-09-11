import { describe, expect, it, vi } from "vitest";
import { requireAuth, requireScope } from "../middleware/auth";

function runAuth(authorization?: string) {
  const req = { headers: { authorization } } as any;
  const res = { locals: {} } as any;
  const next = vi.fn();
  requireAuth(req, res, next);
  return { next, res };
}

function runScope(scopes: string[], required: "jobs.read" | "jobs.write" | "operations.read") {
  const req = {} as any;
  const res = { locals: { auth: { clientId: "test-client", scopes } } } as any;
  const next = vi.fn();
  requireScope(required)(req, res, next);
  return next;
}

describe("API authentication and authorization", () => {
  it("accepts the local/test legacy bearer token as a wildcard principal", () => {
    const { next, res } = runAuth(`Bearer ${process.env.TASKFLOW_API_KEY}`);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.locals.auth).toEqual({ clientId: "legacy", scopes: ["*"] });
  });

  it("rejects missing or incorrect credentials", () => {
    for (const authorization of [undefined, "Bearer wrong-key", `Basic ${process.env.TASKFLOW_API_KEY}`]) {
      const { next } = runAuth(authorization);
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    }
  });

  it("allows a matching scope or wildcard and rejects insufficient scope", () => {
    expect(runScope(["jobs.read"], "jobs.read")).toHaveBeenCalledWith();
    expect(runScope(["*"], "operations.read")).toHaveBeenCalledWith();

    const denied = runScope(["jobs.read"], "jobs.write");
    expect(denied.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });
});
