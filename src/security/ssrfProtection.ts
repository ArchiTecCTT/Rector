/**
 * SSRF protection for user-configurable provider URLs.
 *
 * Validates that URLs do not resolve to private/internal network addresses,
 * cloud instance metadata endpoints, or other blocked destinations.
 */

import * as nodeDns from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Injectable DNS resolver for testing. Override `_resolver.resolve4` and
 * `_resolver.resolve6` in tests to mock DNS responses.
 */
export const _resolver = {
  resolve4: nodeDns.resolve4,
  resolve6: nodeDns.resolve6,
};

// ── Private IP ranges (IPv4 + IPv6) ────────────────────────────────────

export const PRIVATE_RANGES: ReadonlyArray<{
  start: bigint;
  end: bigint;
  label: string;
}> = [
  // Current-network (0.0.0.0/8)
  { start: 0n, end: ipv4End("0.255.255.255"), label: "current-network (0.0.0.0/8)" },
  // Loopback (127.0.0.0/8)
  { start: ipv4Start("127.0.0.0"), end: ipv4End("127.255.255.255"), label: "loopback (127.0.0.0/8)" },
  // RFC1918 — 10.0.0.0/8
  { start: ipv4Start("10.0.0.0"), end: ipv4End("10.255.255.255"), label: "RFC1918 (10.0.0.0/8)" },
  // RFC1918 — 172.16.0.0/12
  { start: ipv4Start("172.16.0.0"), end: ipv4End("172.31.255.255"), label: "RFC1918 (172.16.0.0/12)" },
  // RFC1918 — 192.168.0.0/16
  { start: ipv4Start("192.168.0.0"), end: ipv4End("192.168.255.255"), label: "RFC1918 (192.168.0.0/16)" },
  // Link-local (169.254.0.0/16)
  { start: ipv4Start("169.254.0.0"), end: ipv4End("169.254.255.255"), label: "link-local (169.254.0.0/16)" },
  // CGNAT (100.64.0.0/10)
  { start: ipv4Start("100.64.0.0"), end: ipv4End("100.127.255.255"), label: "CGNAT (100.64.0.0/10)" },
  // IPv6 loopback (::1)
  { start: ipv6Start("::1"), end: ipv6End("::1"), label: "IPv6 loopback (::1)" },
  // IPv6 link-local (fe80::/10)
  { start: ipv6Start("fe80::"), end: ipv6End("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), label: "IPv6 link-local (fe80::/10)" },
  // IPv6 unique local (fc00::/7)
  { start: ipv6Start("fc00::"), end: ipv6End("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), label: "IPv6 unique local (fc00::/7)" },
];

// ── Blocked hostnames ──────────────────────────────────────────────────

export const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.internal.",
  "metadata.azure.internal",
  "metadata.azure.internal.",
  "169.254.169.254",
]);

// ── Helpers ────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): bigint {
  const parts = ip.split(".").map(Number);
  return (
    (BigInt(parts[0]) << 24n) |
    (BigInt(parts[1]) << 16n) |
    (BigInt(parts[2]) << 8n) |
    BigInt(parts[3])
  );
}

function ipv6ToBigInt(ip: string): bigint {
  // Expand :: shorthand
  let expanded = ip;
  if (expanded.includes("::")) {
    const [left, right] = expanded.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    expanded = [...leftParts, ...Array(missing).fill("0"), ...rightParts].join(":");
  }
  const parts = expanded.split(":");
  let result = 0n;
  for (const part of parts) {
    result = (result << 16n) | BigInt(parseInt(part || "0", 16));
  }
  return result;
}

function ipv4Start(ip: string): bigint {
  return ipv4ToInt(ip);
}

function ipv4End(ip: string): bigint {
  return ipv4ToInt(ip);
}

function ipv6Start(ip: string): bigint {
  return ipv6ToBigInt(ip);
}

function ipv6End(ip: string): bigint {
  return ipv6ToBigInt(ip);
}

export function isPrivateIp(ip: string): string | null {
  const ipType = isIP(ip);
  let numeric: bigint;

  if (ipType === 4) {
    numeric = ipv4ToInt(ip);
  } else if (ipType === 6) {
    numeric = ipv6ToBigInt(ip);
  } else {
    return "invalid IP address";
  }

  for (const range of PRIVATE_RANGES) {
    if (numeric >= range.start && numeric <= range.end) {
      return range.label;
    }
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Validate that a provider URL does not point to a private/internal network
 * address or a blocked hostname (SSRF protection).
 *
 * @throws {Error} If the URL violates SSRF protection rules.
 */
export async function validateProviderUrl(urlString: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`SSRF protection: invalid URL "${urlString}"`);
  }

  // Protocol check — only http and https allowed
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `SSRF protection: protocol "${url.protocol}" is not allowed (only http: and https:)`
    );
  }

  // URL.hostname wraps IPv6 in brackets (e.g. "[::1]"). Strip them for IP checks.
  const rawHostname = url.hostname.replace(/^\[(.+)]$/, "$1").toLowerCase();

  // Blocked hostname check
  if (BLOCKED_HOSTNAMES.has(rawHostname) || BLOCKED_HOSTNAMES.has(rawHostname + ".")) {
    throw new Error(
      `SSRF protection: hostname "${rawHostname}" is blocked (cloud metadata / localhost)`
    );
  }

  // IP literal check — direct IP in hostname
  const ipType = isIP(rawHostname);
  if (ipType !== 0) {
    const label = isPrivateIp(rawHostname);
    if (label) {
      throw new Error(
        `SSRF protection: IP address "${rawHostname}" is in a private range (${label})`
      );
    }
    return; // Public IP — allowed
  }

  // DNS hostname — resolve and check all resolved IPs
  let resolvedIps: string[];
  try {
    const [v4, v6] = await Promise.all([
      _resolver.resolve4(rawHostname).catch(() => [] as string[]),
      _resolver.resolve6(rawHostname).catch(() => [] as string[]),
    ]);
    resolvedIps = [...v4, ...v6];
  } catch {
    throw new Error(
      `SSRF protection: could not resolve hostname "${rawHostname}"`
    );
  }

  if (resolvedIps.length === 0) {
    throw new Error(
      `SSRF protection: hostname "${rawHostname}" did not resolve to any IP address`
    );
  }

  for (const ip of resolvedIps) {
    const label = isPrivateIp(ip);
    if (label) {
      throw new Error(
        `SSRF protection: hostname "${rawHostname}" resolves to private IP "${ip}" (${label})`
      );
    }
  }
}
