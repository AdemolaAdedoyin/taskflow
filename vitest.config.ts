import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // CI (and explicit local integration runs) provide real dependency URLs.
      // Unit-only local runs keep self-contained fallback values because their
      // database/queue boundaries are mocked.
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      TASKFLOW_API_KEY: process.env.TASKFLOW_API_KEY ?? "test-key",
      NODE_ENV: "test",
    },
  },
});
