import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      REDIS_URL: "redis://localhost:6379",
      TASKFLOW_API_KEY: "test-key",
      NODE_ENV: "test",
    },
  },
});
