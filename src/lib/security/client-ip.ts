import "server-only";
/**
 * Resolving the caller's IP address, for rate-limit keys and nothing else.
 *
 * `X-Forwarded-For` and `X-Real-IP` are just request headers: any client can
 * send them. They are only believed when `TRUST_PROXY_HEADERS` is `true`/`1`,
 * which is correct exactly when the app sits behind exactly one proxy or load
 * balancer that owns the last entry of those headers — an ALB, CloudFront,
 * Vercel, nginx with `proxy_set_header`. Set it anywhere else and every
 * attacker gets an unlimited supply of fresh rate-limit buckets.
 *
 * When the headers are not trusted there is nothing else to use: Next's
 * `Request` does not expose the socket address, so every caller collapses into
 * {@link UNKNOWN_IP}. One shared bucket for the whole deployment is worse than
 * no bucket at all — the first ten sign-in attempts anywhere would lock out
 * everybody else — so per-IP policies are *switched off* rather than shared:
 * {@link ipRateLimitKey} returns `null` and the call site skips that policy.
 * Per-account, per-user and per-API-key limits are unaffected and are the ones
 * that actually protect credentials. **A production deployment must set
 * `TRUST_PROXY_HEADERS`**, or it runs with no per-IP limiting at all.
 *
 * The returned value is a rate-limit key, not an audit record. Do not log it at
 * info level and do not store it: an IP address is personal data.
 */

/** `TRUST_PROXY_HEADERS` values that mean "yes". Anything else means no. */
const TRUTHY = new Set(["true", "1"]);

/**
 * Used when no trustworthy address is available. Not a valid IP, so it can
 * never collide with a real one.
 */
export const UNKNOWN_IP = "unknown";

/**
 * Whether `X-Forwarded-*` headers may be believed on this deployment.
 *
 * Read on every call rather than memoised at module load: the value is only
 * consulted per request, and a lazy read keeps the module importable in
 * environments (tests, build) where the variable is not set yet.
 *
 * Exported because forwarded headers are not only a rate-limit concern: the
 * CSRF origin check in `src/lib/api/auth.ts` has the same question to answer
 * about `X-Forwarded-Host`.
 */
export function trustProxyHeaders(): boolean {
  const value = process.env.TRUST_PROXY_HEADERS;
  return typeof value === "string" && TRUTHY.has(value.trim().toLowerCase());
}

/** Strict dotted-quad check: 4 octets, 0-255, no leading zeros (`01` is ambiguous). */
function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }
    return Number(part) <= 255;
  });
}

/**
 * Structural IPv6 check: hex groups separated by `:`, at most one `::`
 * compression, an optional trailing IPv4 form (`::ffff:1.2.3.4`).
 */
function isIpv6(value: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(value) || !value.includes(":")) {
    return false;
  }

  const halves = value.split("::");
  if (halves.length > 2) {
    return false;
  }
  const compressed = halves.length === 2;

  let groups = 0;
  for (const [index, half] of halves.entries()) {
    if (half === "") {
      continue;
    }
    const parts = half.split(":");
    for (const [partIndex, part] of parts.entries()) {
      const isLastPartOfAddress =
        index === halves.length - 1 && partIndex === parts.length - 1;
      if (isLastPartOfAddress && part.includes(".")) {
        // A trailing IPv4 literal occupies the final two groups.
        if (!isIpv4(part)) {
          return false;
        }
        groups += 2;
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) {
        return false;
      }
      groups += 1;
    }
  }

  // Without `::` the address must be complete; with it, at least one group must
  // actually have been elided.
  return compressed ? groups <= 7 : groups === 8;
}

/**
 * Normalises one address candidate: strips brackets, a trailing port, the IPv6
 * zone id (`fe80::1%eth0`) and the IPv4-mapped prefix (`::ffff:1.2.3.4`), so
 * the same client always produces the same rate-limit key.
 *
 * @returns the canonical address, or `null` when it does not look like an IP.
 */
function normalizeIp(candidate: string): string | null {
  let value = candidate.trim();
  if (value === "") {
    return null;
  }

  // `[::1]:443` or `[::1]` — the bracket form always wraps an IPv6 literal.
  const bracketed = /^\[(.+?)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
    // `1.2.3.4:5678`. Bare IPv6 is never port-suffixed without brackets, so a
    // single colon on a dotted-quad is unambiguous.
    value = value.slice(0, value.lastIndexOf(":"));
  }

  const zone = value.indexOf("%");
  if (zone !== -1) {
    value = value.slice(0, zone);
  }

  if (isIpv4(value)) {
    return value;
  }

  const mapped = /^::[fF]{4}:(.+)$/.exec(value);
  if (mapped && isIpv4(mapped[1])) {
    return mapped[1];
  }

  if (isIpv6(value)) {
    return value.toLowerCase();
  }

  return null;
}

/**
 * Best-effort client address for use as a rate-limit key.
 *
 * Reads `X-Forwarded-For` from the **right**, then `X-Real-IP`, and only when
 * `TRUST_PROXY_HEADERS` says those headers come from our own edge.
 *
 * The last entry, not the first: ALB and CloudFront *append* the address they
 * saw to whatever the request already carried, so a client that sends its own
 * `X-Forwarded-For: 1.2.3.4` owns the first entry and would otherwise mint a
 * fresh bucket per request. The final entry is the one our own trusted hop
 * wrote, and it is the only one nobody upstream of us could forge.
 *
 * This assumes exactly **one** trusted proxy in front of the app. If a second
 * one is ever added (an ALB behind CloudFront, say), the client address moves
 * to the second-from-the-right and this must take the Nth entry from the right,
 * N being the number of trusted hops.
 *
 * @returns a normalised IP, or {@link UNKNOWN_IP} when none can be trusted.
 */
export function clientIpFrom(headers: Headers): string {
  if (!trustProxyHeaders()) {
    return UNKNOWN_IP;
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const candidates = forwarded.split(",");
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const ip = normalizeIp(candidates[index]);
      if (ip) {
        return ip;
      }
    }
  }

  const real = headers.get("x-real-ip");
  if (real) {
    const ip = normalizeIp(real);
    if (ip) {
      return ip;
    }
  }

  return UNKNOWN_IP;
}

/** {@link clientIpFrom} for a `Request` (Route Handlers). */
export function clientIp(request: Request): string {
  return clientIpFrom(request.headers);
}

/**
 * Whether the "per-IP limits are off" warning has already been printed. Once
 * per process: the condition is a deployment setting, so a line per request
 * would be pure noise.
 */
let warnedAboutUnknownIp = false;

/**
 * Builds the rate-limit key for an IP-keyed policy, or `null` when there is no
 * address to key on.
 *
 * `null` means **skip that policy**, not "use a shared bucket": lumping every
 * caller into one counter would let a single client exhaust a limit for the
 * whole deployment, which is a denial of service handed out for free. Callers
 * must still run their per-account, per-user and per-key policies, which do not
 * depend on the address.
 *
 * @param prefix key namespace *including* its trailing separator, so the key
 * says what it is: `"ip:"`, `"login:ip:"`, `"reset:ip:"`.
 * @param ip an address from {@link clientIpFrom}.
 */
export function ipRateLimitKey(prefix: string, ip: string): string | null {
  if (ip === UNKNOWN_IP) {
    if (!warnedAboutUnknownIp) {
      warnedAboutUnknownIp = true;
      console.warn(
        "[security] Client IP unavailable (TRUST_PROXY_HEADERS unset); per-IP rate limits are disabled.",
      );
    }
    return null;
  }
  return `${prefix}${ip}`;
}
