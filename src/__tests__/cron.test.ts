import { describe, it, expect } from "vitest";
import { isValidCronExpression, nextRunFromCron } from "../lib/cron";

describe("cron helpers", () => {
  it("accepts standard 5-field cron expressions", () => {
    expect(isValidCronExpression("0 2 * * *")).toBe(true);
    expect(isValidCronExpression("*/15 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
  });

  it("rejects garbage input", () => {
    expect(isValidCronExpression("not a cron")).toBe(false);
    expect(isValidCronExpression("")).toBe(false);
    expect(isValidCronExpression("61 * * * *")).toBe(false); // minute out of range
  });

  it("computes a next-run time in the future", () => {
    const next = nextRunFromCron("0 2 * * *", "UTC");
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it("respects an explicit timezone", () => {
    const utc = nextRunFromCron("0 12 * * *", "UTC");
    const ny = nextRunFromCron("0 12 * * *", "America/New_York");
    // Noon UTC and noon in New York are different instants.
    expect(utc.getTime()).not.toEqual(ny.getTime());
  });
});
