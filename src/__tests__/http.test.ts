import { describe, expect, it } from "vitest";
import { readResponseTextLimited } from "../lib/http";

describe("HTTP response helpers", () => {
  it("stops reading after the configured byte limit", async () => {
    const response = new Response("x".repeat(10_000));
    const text = await readResponseTextLimited(response, 256);

    expect(text).toHaveLength(256);
    expect(text).toBe("x".repeat(256));
  });
});
