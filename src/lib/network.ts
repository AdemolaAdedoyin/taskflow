import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const blockedAddresses = new BlockList();

// IPv4 ranges that should never be reachable from generic user-supplied jobs.
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("100.64.0.0", 10, "ipv4");
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedAddresses.addSubnet("192.0.0.0", 24, "ipv4");
blockedAddresses.addSubnet("192.0.2.0", 24, "ipv4");
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4");
blockedAddresses.addSubnet("198.18.0.0", 15, "ipv4");
blockedAddresses.addSubnet("198.51.100.0", 24, "ipv4");
blockedAddresses.addSubnet("203.0.113.0", 24, "ipv4");
blockedAddresses.addSubnet("224.0.0.0", 4, "ipv4");
blockedAddresses.addSubnet("240.0.0.0", 4, "ipv4");

// IPv6 loopback, private/link-local, multicast and documentation ranges.
blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");
blockedAddresses.addSubnet("ff00::", 8, "ipv6");
blockedAddresses.addSubnet("2001:db8::", 32, "ipv6");

const defaultResolver: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family }));
};

function assertPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 0) throw new Error(`Resolved address '${address}' is invalid`);

  // Be conservative with IPv4-mapped IPv6 addresses. Node's BlockList can
  // normalize families in surprising ways, and mapped literals are unnecessary
  // for Taskflow's generic outbound jobs.
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    throw new Error("HTTP job target resolves to a private or reserved network address");
  }

  const type = family === 6 ? "ipv6" : "ipv4";
  if (blockedAddresses.check(address, type)) {
    throw new Error("HTTP job target resolves to a private or reserved network address");
  }
}

/**
 * Validate an outbound HTTP target before the worker connects to it.
 *
 * Redirects are disabled separately by the HTTP handler so a public endpoint
 * cannot bounce a validated request into an internal network address.
 */
export async function assertSafeHttpUrl(rawUrl: string, resolver: HostResolver = defaultResolver) {
  const url = new URL(rawUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("HTTP jobs only support http:// and https:// targets");
  }
  if (url.username || url.password) {
    throw new Error("HTTP job target URLs must not contain embedded credentials");
  }

  // WHATWG URLs retain brackets around IPv6 literals in `hostname`.
  const rawHostname = url.hostname.toLowerCase();
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("HTTP job target hostname is not allowed");
  }

  if (isIP(hostname)) {
    assertPublicAddress(hostname);
    return url;
  }

  const addresses = await resolver(hostname);
  if (addresses.length === 0) {
    throw new Error("HTTP job target did not resolve to an address");
  }

  for (const { address } of addresses) assertPublicAddress(address);
  return url;
}
