import { describe, expect, it } from "vitest";
import { parseApiClients } from "../lib/apiClientsConfig";

describe("API client configuration", () => {
  it("parses multiple clients and scopes", () => {
    expect(
      parseApiClients(
        "writer:writer-secret:jobs.read|jobs.write,operator:operator-secret:operations.read"
      )
    ).toEqual([
      { id: "writer", secret: "writer-secret", scopes: ["jobs.read", "jobs.write"] },
      { id: "operator", secret: "operator-secret", scopes: ["operations.read"] },
    ]);
  });

  it("supports a wildcard administrative client", () => {
    expect(parseApiClients("admin:admin-secret:*")).toEqual([
      { id: "admin", secret: "admin-secret", scopes: ["*"] },
    ]);
  });

  it("rejects malformed clients, ambiguous ids, duplicate ids, and invalid scopes", () => {
    expect(() => parseApiClients("writer:secret")).toThrow(/clientId:secret:scope/);
    expect(() => parseApiClients("service.prod:secret:jobs.read")).toThrow(/client id/);
    expect(() => parseApiClients("writer:secret:jobs.read,writer:secret2:jobs.write")).toThrow(/Duplicate/);
    expect(() => parseApiClients("writer:secret:jobs.delete")).toThrow(/Allowed scopes/);
    expect(() => parseApiClients("admin:secret:*|jobs.read")).toThrow(/cannot combine/);
  });
});
