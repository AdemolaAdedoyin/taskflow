import { describe, expect, it } from "vitest";
import { assertSafeHttpUrl, HostResolver } from "../lib/network";

const resolvesTo = (address: string, family = 4): HostResolver => async () => [{ address, family }];

describe("outbound HTTP target validation", () => {
  it("accepts an http/https hostname when every resolved address is public", async () => {
    const url = await assertSafeHttpUrl("https://example.com/callback", resolvesTo("93.184.216.34"));
    expect(url.hostname).toBe("example.com");
  });

  it("rejects loopback and private literal addresses", async () => {
    await expect(assertSafeHttpUrl("http://127.0.0.1/admin")).rejects.toThrow(/private or reserved/);
    await expect(assertSafeHttpUrl("http://10.2.3.4/internal")).rejects.toThrow(/private or reserved/);
    await expect(assertSafeHttpUrl("http://[::1]/internal")).rejects.toThrow(/private or reserved/);
  });

  it("rejects a public hostname if DNS resolves it to a private address", async () => {
    await expect(
      assertSafeHttpUrl("https://example.com/internal", resolvesTo("169.254.169.254"))
    ).rejects.toThrow(/private or reserved/);
  });

  it("rejects local hostnames before DNS resolution", async () => {
    await expect(assertSafeHttpUrl("http://localhost:4000/health")).rejects.toThrow(/hostname is not allowed/);
    await expect(assertSafeHttpUrl("http://service.local/api")).rejects.toThrow(/hostname is not allowed/);
  });

  it("rejects non-HTTP schemes and embedded credentials", async () => {
    await expect(assertSafeHttpUrl("ftp://example.com/file", resolvesTo("93.184.216.34"))).rejects.toThrow(
      /only support http/
    );
    await expect(
      assertSafeHttpUrl("https://user:secret@example.com/path", resolvesTo("93.184.216.34"))
    ).rejects.toThrow(/embedded credentials/);
  });
});
