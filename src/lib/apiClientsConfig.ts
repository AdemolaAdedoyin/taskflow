export type ApiScope = "jobs.read" | "jobs.write" | "operations.read" | "*";

export interface ApiClientConfig {
  id: string;
  secret: string;
  scopes: ApiScope[];
}

const allowedScopes = new Set<ApiScope>(["jobs.read", "jobs.write", "operations.read", "*"]);

/**
 * Format: clientId:secret:scope|scope,clientId2:secret2:scope
 * Secrets should be base64url/hex-like values without commas or colons.
 */
export function parseApiClients(value: string): ApiClientConfig[] {
  if (!value.trim()) return [];

  const clients: ApiClientConfig[] = [];
  const ids = new Set<string>();

  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const firstSeparator = entry.indexOf(":");
    const secondSeparator = entry.indexOf(":", firstSeparator + 1);
    if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1 || secondSeparator === entry.length - 1) {
      throw new Error(`Invalid TASKFLOW_API_CLIENTS entry '${entry}'. Use clientId:secret:scope|scope.`);
    }

    const id = entry.slice(0, firstSeparator).trim();
    const secret = entry.slice(firstSeparator + 1, secondSeparator).trim();
    const scopes = entry
      .slice(secondSeparator + 1)
      .split("|")
      .map((scope) => scope.trim())
      .filter(Boolean) as ApiScope[];

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new Error(`Invalid TASKFLOW_API_CLIENTS client id '${id}'. Use 1-64 letters, numbers, dot, underscore, or dash.`);
    }
    if (!secret || /[:,\s]/.test(secret)) {
      throw new Error(`Invalid TASKFLOW_API_CLIENTS secret for '${id}'. Secrets must not contain commas, colons, or whitespace.`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate TASKFLOW_API_CLIENTS client id '${id}'.`);
    }
    if (scopes.length === 0 || scopes.some((scope) => !allowedScopes.has(scope))) {
      throw new Error(
        `Invalid TASKFLOW_API_CLIENTS scopes for '${id}'. Allowed scopes: jobs.read, jobs.write, operations.read, *.`
      );
    }
    if (scopes.includes("*") && scopes.length > 1) {
      throw new Error(`TASKFLOW_API_CLIENTS client '${id}' cannot combine '*' with other scopes.`);
    }
    if (new Set(scopes).size !== scopes.length) {
      throw new Error(`TASKFLOW_API_CLIENTS client '${id}' contains duplicate scopes.`);
    }

    ids.add(id);
    clients.push({ id, secret, scopes });
  }

  return clients;
}
