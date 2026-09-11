import { describe, expect, it } from "vitest";
import { parseHandlerConcurrencyLimits, parseHandlerRateLimits } from "../lib/handlerLimitsConfig";

describe("handler limit configuration", () => {
  it("parses concurrency and rate policies", () => {
    expect(parseHandlerConcurrencyLimits("http_request:2, simulate_failure:4")).toEqual({
      http_request: 2,
      simulate_failure: 4,
    });
    expect(parseHandlerRateLimits("http_request:30/60000,log_message:100/1000")).toEqual({
      http_request: { max: 30, windowMs: 60_000 },
      log_message: { max: 100, windowMs: 1_000 },
    });
  });

  it("treats empty configuration as unlimited", () => {
    expect(parseHandlerConcurrencyLimits(" ")).toEqual({});
    expect(parseHandlerRateLimits("")).toEqual({});
  });

  it("rejects malformed or duplicate policies", () => {
    expect(() => parseHandlerConcurrencyLimits("http_request:0")).toThrow(/positive integer/);
    expect(() => parseHandlerConcurrencyLimits("http_request:2,http_request:3")).toThrow(/Duplicate/);
    expect(() => parseHandlerRateLimits("http_request:10")).toThrow(/max\/windowMs/);
    expect(() => parseHandlerRateLimits("http_request:10/0")).toThrow(/positive integers/);
  });
});
