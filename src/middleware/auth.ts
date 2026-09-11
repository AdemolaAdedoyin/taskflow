import { createHash, timingSafeEqual } from "node:crypto";
import { RequestHandler } from "express";
import { ApiScope } from "../lib/apiClientsConfig";
import { ForbiddenError, UnauthorizedError } from "../lib/errors";
import { config } from "../config";

export interface AuthPrincipal {
  clientId: string;
  scopes: ApiScope[];
}

function secureTokenEquals(candidate: string, expected: string) {
  // Hash both values first so timingSafeEqual always compares equal-length
  // buffers and does not leak token length through an early string mismatch.
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function authenticateBearerToken(token: string): AuthPrincipal | undefined {
  const separator = token.indexOf(".");
  if (separator > 0 && separator < token.length - 1) {
    const clientId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const client = config.TASKFLOW_API_CLIENTS.find((candidate) => candidate.id === clientId);

    // Do the same fixed-length comparison even for an unknown client id so the
    // authentication path does not immediately short-circuit on identifier lookup.
    const expectedSecret = client?.secret ?? "taskflow-invalid-client-secret";
    if (secureTokenEquals(secret, expectedSecret) && client) {
      return { clientId: client.id, scopes: client.scopes };
    }
  }

  // Local/test compatibility only. Production explicitly disables the legacy
  // shared key so deployed callers must identify themselves with scoped keys.
  if (config.LEGACY_API_KEY && secureTokenEquals(token, config.LEGACY_API_KEY)) {
    return { clientId: "legacy", scopes: ["*"] };
  }

  return undefined;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization ?? "";
  const [scheme, token, ...extra] = header.split(" ");

  if (!token || extra.length > 0 || scheme?.toLowerCase() !== "bearer") {
    next(new UnauthorizedError());
    return;
  }

  const principal = authenticateBearerToken(token);
  if (!principal) {
    next(new UnauthorizedError());
    return;
  }

  res.locals.auth = principal;
  next();
};

export function requireScope(scope: Exclude<ApiScope, "*">): RequestHandler {
  return (_req, res, next) => {
    const principal = res.locals.auth as AuthPrincipal | undefined;
    if (!principal) {
      next(new UnauthorizedError());
      return;
    }

    if (!principal.scopes.includes("*") && !principal.scopes.includes(scope)) {
      next(new ForbiddenError(`API client '${principal.clientId}' requires scope '${scope}'`));
      return;
    }

    next();
  };
}
