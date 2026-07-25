"use node";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type LookupResult = { address: string; family: number };
type Resolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupResult[]>;

function unsafeIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function unsafeIpv6(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%", 1)[0];
  const mappedIpv4 = normalized.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return unsafeIpv4(mappedIpv4[1]);
  const mappedHex = normalized.match(
    /^(?:::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return unsafeIpv4(
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
    );
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    /^fe[c-f]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

export function isUnsafeWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return unsafeIpv4(address);
  if (family === 6) return unsafeIpv6(address);
  return true;
}

export async function assertSafeWebhookDestination(
  value: string,
  resolve: Resolver = lookup,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Blocked unsafe webhook destination");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.hostname
  ) {
    throw new Error("Blocked unsafe webhook destination");
  }

  let addresses: LookupResult[];
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await resolve(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Webhook destination could not be resolved");
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isUnsafeWebhookAddress(address))
  ) {
    throw new Error("Blocked unsafe webhook destination");
  }
}
