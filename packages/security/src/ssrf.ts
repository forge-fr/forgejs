import { SsrfBlockedError } from './errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function parseIpv4Number(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function isPrivateOrReservedIpv4Int(ipInt: number): boolean {
  const first = (ipInt >>> 24) & 0xff;
  const second = (ipInt >>> 16) & 0xff;

  // 0.0.0.0/8 (unspecified / current network)
  if (first === 0) return true;
  // 10.0.0.0/8 (RFC 1918 private)
  if (first === 10) return true;
  // 100.64.0.0/10 (CGNAT / shared address space)
  if (first === 100 && second >= 64 && second <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (first === 127) return true;
  // 169.254.0.0/16 (link-local & cloud metadata 169.254.169.254)
  if (first === 169 && second === 254) return true;
  // 172.16.0.0/12 (RFC 1918 private)
  if (first === 172 && second >= 16 && second <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (first === 192 && second === 0 && ((ipInt >>> 8) & 0xff) === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (first === 192 && second === 0 && ((ipInt >>> 8) & 0xff) === 2) return true;
  // 192.168.0.0/16 (RFC 1918 private)
  if (first === 192 && second === 168) return true;
  // 198.18.0.0/15 (benchmarking)
  if (first === 198 && (second === 18 || second === 19)) return true;
  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved / broadcast)
  if (first >= 224) return true;

  return false;
}

function parseIpv6Groups(rawIp: string): number[] | null {
  const trimmed = rawIp.startsWith('[') && rawIp.endsWith(']') ? rawIp.slice(1, -1) : rawIp;
  const noZone = trimmed.split('%')[0] ?? '';
  if (!noZone.includes(':')) {
    return null;
  }

  let working = noZone.toLowerCase();

  // Convert trailing embedded IPv4 dotted quad (e.g. ::ffff:169.254.169.254) into two 16-bit hex groups
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4Int = parseIpv4Number(tail);
    if (ipv4Int === null) {
      return null;
    }
    const hi = ((ipv4Int >>> 16) & 0xffff).toString(16);
    const lo = (ipv4Int & 0xffff).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = working.split('::');
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(':').filter((s) => s.length > 0) : [];
  const right = halves[1] ? halves[1].split(':').filter((s) => s.length > 0) : [];
  const missing = 8 - (left.length + right.length);

  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 0)) {
    return null;
  }

  const allHex =
    halves.length === 2
      ? [...left, ...Array<string>(missing).fill('0'), ...right]
      : left;

  if (allHex.length !== 8) {
    return null;
  }

  const groups: number[] = [];
  for (const hex of allHex) {
    if (!/^[0-9a-f]{1,4}$/.test(hex)) {
      return null;
    }
    groups.push(Number.parseInt(hex, 16));
  }
  return groups;
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const cleaned = rawIp.trim();
  const ipv4Int = parseIpv4Number(cleaned);
  if (ipv4Int !== null) {
    return isPrivateOrReservedIpv4Int(ipv4Int);
  }

  const groups = parseIpv6Groups(cleaned);
  if (groups === null) {
    return false;
  }

  const g0 = groups[0]!;
  const g1 = groups[1]!;
  const g2 = groups[2]!;
  const g3 = groups[3]!;
  const g4 = groups[4]!;
  const g5 = groups[5]!;
  const g6 = groups[6]!;
  const g7 = groups[7]!;

  // :: (unspecified) and ::1 (loopback)
  const firstSevenZero =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0;
  if (firstSevenZero && (g7 === 0 || g7 === 1)) {
    return true;
  }

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const mappedIpv4 = (((g6 << 16) | g7) >>> 0);
    return isPrivateOrReservedIpv4Int(mappedIpv4);
  }

  // 64:ff9b::/96 (NAT64 well-known prefix embedding IPv4)
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const mappedIpv4 = (((g6 << 16) | g7) >>> 0);
    return isPrivateOrReservedIpv4Int(mappedIpv4);
  }

  // fc00::/7 (Unique Local Addresses: fc00:: - fdff::)
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 (Link-Local)
  if ((g0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // ff00::/8 (Multicast)
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }

  // 2001:db8::/32 (Documentation)
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return true;
  }

  return false;
}

export interface SafeOutboundUrlOptions {
  /** Allow `http:` in addition to `https:` (default: `false`). */
  readonly allowHttp?: boolean;
  /** Optional explicit allowlist of destination hostnames (lowercase). */
  readonly allowedHosts?: readonly string[];
  /** Optional allowlist of numeric TCP ports (default: `[443]` or `[80, 443]` when allowHttp is true). */
  readonly allowedPorts?: readonly number[];
  /**
   * Optional DNS resolver callback returning all IPv4/IPv6 addresses for a hostname.
   * Strongly recommended in Node.js/Bun apps to block DNS-rebinding attacks.
   */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(lower)) {
    return true;
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

export async function validateOutboundUrl(
  rawUrl: string | URL,
  options: SafeOutboundUrlOptions = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Invalid outbound URL');
  }

  const allowHttp = options.allowHttp ?? false;
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new SsrfBlockedError(`Disallowed outbound URL scheme "${parsed.protocol}"`);
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new SsrfBlockedError('Embedded credentials in outbound URLs are forbidden');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) {
    throw new SsrfBlockedError('Outbound URL missing hostname');
  }

  const effectivePort =
    parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : 80;
  const allowedPorts = options.allowedPorts ?? (allowHttp ? [80, 443] : [443]);
  if (!allowedPorts.includes(effectivePort)) {
    throw new SsrfBlockedError(`Disallowed outbound port ${effectivePort}`);
  }

  if (isBlockedHostname(hostname)) {
    throw new SsrfBlockedError(`Blocked internal hostname "${hostname}"`);
  }

  // Strip IPv6 brackets when checking IP literal
  const unwrappedHost =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

  if (isPrivateOrReservedIp(unwrappedHost)) {
    throw new SsrfBlockedError('Outbound request to private or reserved IP is blocked');
  }

  if (options.allowedHosts !== undefined && options.allowedHosts.length > 0) {
    const normalizedAllowlist = options.allowedHosts.map((h) => h.toLowerCase());
    if (!normalizedAllowlist.includes(hostname)) {
      throw new SsrfBlockedError(`Hostname "${hostname}" is not in allowedHosts`);
    }
  }

  if (options.resolveHost !== undefined && parseIpv4Number(unwrappedHost) === null && parseIpv6Groups(unwrappedHost) === null) {
    let resolvedIps: readonly string[];
    try {
      resolvedIps = await options.resolveHost(unwrappedHost);
    } catch {
      throw new SsrfBlockedError('Failed to resolve outbound hostname');
    }
    if (!Array.isArray(resolvedIps) || resolvedIps.length === 0) {
      throw new SsrfBlockedError('Outbound hostname resolved to no IP addresses');
    }
    for (const ip of resolvedIps) {
      if (isPrivateOrReservedIp(ip)) {
        throw new SsrfBlockedError('Outbound hostname resolved to private or reserved IP');
      }
    }
  }

  return parsed;
}

export interface SafeFetchOptions extends SafeOutboundUrlOptions {
  /** Maximum redirect hops manually validated (default: 5). */
  readonly maxRedirects?: number;
  /** Custom underlying fetch implementation (defaults to `globalThis.fetch`). */
  readonly fetchImpl?: typeof fetch;
}

export type SafeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const maxRedirects = options.maxRedirects ?? 5;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    let currentUrl = await validateOutboundUrl(input, options);
    let currentInit: RequestInit = { ...init, redirect: 'manual' };

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await fetchImpl(currentUrl.toString(), currentInit);

      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }

      if (hop === maxRedirects) {
        throw new SsrfBlockedError(`Exceeded maximum safe redirects (${maxRedirects})`);
      }

      const location = response.headers.get('location');
      if (location === null || location.trim().length === 0) {
        return response;
      }

      const nextUrl = new URL(location, currentUrl);
      currentUrl = await validateOutboundUrl(nextUrl, options);

      // RFC 9110: 303 switches method to GET and drops body; strip Authorization on cross-origin redirect
      const headers = new Headers(currentInit.headers);
      if (nextUrl.origin !== new URL(input instanceof URL ? input.toString() : input).origin) {
        headers.delete('authorization');
        headers.delete('cookie');
      }

      if (response.status === 303) {
        const { body: _droppedBody, ...restInit } = currentInit;
        currentInit = { ...restInit, method: 'GET', headers, redirect: 'manual' };
      } else {
        currentInit = { ...currentInit, headers, redirect: 'manual' };
      }
    }

    throw new SsrfBlockedError('Redirect handling failed');
  };
}
