import { describe, it, expect } from "vitest";
import { getHandler } from "../queue/handlers";
import { simulateFailureHandler } from "../queue/handlers/simulateFailure.handler";
import { logMessageHandler } from "../queue/handlers/logMessage.handler";

describe("handler registry", () => {
  it("resolves a registered handler by type", () => {
    expect(getHandler("log_message")).toBe(logMessageHandler);
  });

  it("throws a descriptive error for an unregistered type", () => {
    expect(() => getHandler("nonexistent_type")).toThrow(/No handler registered/);
  });
});

describe("simulateFailureHandler", () => {
  it("fails on attempts before failUntilAttempt, then succeeds", async () => {
    await expect(
      simulateFailureHandler({ failUntilAttempt: 3 }, { jobId: "j1", attemptNumber: 1 })
    ).rejects.toThrow(/Simulated failure/);

    await expect(
      simulateFailureHandler({ failUntilAttempt: 3 }, { jobId: "j1", attemptNumber: 2 })
    ).rejects.toThrow(/Simulated failure/);

    await expect(
      simulateFailureHandler({ failUntilAttempt: 3 }, { jobId: "j1", attemptNumber: 3 })
    ).resolves.toEqual({ succeededOnAttempt: 3 });
  });

  it("defaults to failing until attempt 3 when no payload option given", async () => {
    await expect(simulateFailureHandler({}, { jobId: "j1", attemptNumber: 1 })).rejects.toThrow();
    await expect(simulateFailureHandler({}, { jobId: "j1", attemptNumber: 3 })).resolves.toBeDefined();
  });
});
