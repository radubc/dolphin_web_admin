import "server-only";
/**
 * Request rate limiting.
 *
 * Two caveats that shape every number below, and that anyone deploying this app
 * needs to know:
 *
 * 1. **The counter is per process.** There is no Redis in this stack, so the
 *    state lives in this Node process's memory. Run N instances behind a load
 *    balancer and a determined client gets up to N× the configured limit, and a
 *    deploy resets every window. That is acceptable for abuse damping on a
 *    single-instance deployment; it is not a security control on its own.
 *    {@link RateLimiter} exists so a shared-store implementation (Redis,
 *    Upstash, DynamoDB) can be dropped in behind {@link getRateLimiter} without
 *    touching a single call site.
 * 2. **Buckets are only as trustworthy as their key.** Per-IP policies key on
 *    `src/lib/security/client-ip.ts`, which can only name the caller when
 *    `TRUST_PROXY_HEADERS` is set. Without it there is no key, and every
 *    IP-keyed policy is **skipped** rather than collapsed into one shared
 *    counter that any single client could exhaust for the whole deployment —
 *    so a production deployment must set that variable or run with no per-IP
 *    limiting at all. Per-account, per-user and per-API-key policies never
 *    depend on it and are the ones that actually protect credentials.
 *
 * The algorithm is a **sliding window counter**: each key keeps the hit count
 * for the current fixed window plus the count for the previous one, and the
 * previous count is weighted by how much of it still overlaps the trailing
 * window. Two integers per key instead of a timestamp list, no burst at the
 * window boundary the way a fixed window has, and the error versus a true
 * sliding log is a fraction of a percent at these limits.
 */
import { TooManyRequestsError, type RateLimitSnapshot } from "@/lib/api/errors";

/** A named limit: `limit` requests per `windowMs` for one key. */
export interface RateLimitPolicy {
  /**
   * Namespaces the key, so the same IP tracked under two policies gets two
   * independent counters. Stable: it appears in nothing user-visible, but a
   * shared-store implementation will use it as part of the storage key.
   */
  name: string;
  limit: number;
  windowMs: number;
}

/** What the limiter decided, and what the caller may advertise in headers. */
export interface RateLimitVerdict extends RateLimitSnapshot {
  allowed: boolean;
  /** Seconds to wait before retrying. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * The seam. Every call site depends on this, never on the in-memory class, so
 * swapping in a shared store is a one-line change in {@link getRateLimiter}.
 * `consume` is async for exactly that reason.
 */
export interface RateLimiter {
  /** Records one hit against `key` and reports whether it is allowed. */
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitVerdict>;
}

/**
 * The presets. Names are a stable contract (they namespace stored counters);
 * the numbers are tuning and may change.
 */
export const RATE_LIMITS = {
  /**
   * Every user-facing endpoint, per IP and again per authenticated user.
   * 2 rps sustained: far above a person clicking around a finance dashboard,
   * far below a scraper.
   */
  api: { name: "api", limit: 120, windowMs: 60_000 },

  /**
   * Sign-in attempts from one address. Generous enough for a shared office
   * that fat-fingers passwords, tight enough that credential stuffing from a
   * single host is pointless.
   */
  authLogin: { name: "auth_login", limit: 10, windowMs: 15 * 60_000 },

  /**
   * Sign-in attempts against one *account*, keyed by lowercased email. This is
   * the one that matters: it survives an attacker rotating through a botnet,
   * and it is the reason the per-IP limit can stay friendly. 5 per 15 minutes
   * is above any honest typo rate and below anything worth calling a guess.
   */
  authLoginAccount: { name: "auth_login_account", limit: 5, windowMs: 15 * 60_000 },

  /**
   * Password-reset requests and code confirmations. Low: each request costs a
   * real email, and the confirm step is a 6-digit-code guess.
   */
  authReset: { name: "auth_reset", limit: 5, windowMs: 15 * 60_000 },

  /**
   * The second leg of a passkey sign-in (the assertion answered to Cognito),
   * keyed `passkey:email:<pool username>`. Its own budget, so an honest
   * passkey sign-in — two calls — does not spend two of `authLoginAccount`'s
   * five attempts; the first leg still charges the login budget.
   */
  authPasskey: { name: "auth_passkey", limit: 10, windowMs: 15 * 60_000 },

  /**
   * Token refresh. Higher than sign-in because a legitimate multi-tab session
   * refreshes on its own schedule, still low enough to make a stolen refresh
   * token a poor oracle.
   */
  authRefresh: { name: "auth_refresh", limit: 30, windowMs: 15 * 60_000 },

  /**
   * The health probe. One monitor polls every 10-30 s; 30/min leaves room for
   * several of them without letting the endpoint become a free DB pinger.
   */
  health: { name: "health", limit: 30, windowMs: 60_000 },

  /**
   * Machine clients holding an API key. An order of magnitude above the browser
   * limit: batch jobs are bursty, and the key already identifies the caller.
   */
  service: { name: "service", limit: 600, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * Hard cap on tracked keys, so a flood of distinct keys (spoofed forwarded-for
 * headers, enumerated emails) cannot grow the map without bound. ~100 bytes per
 * entry, so the ceiling is a few MB. Eviction is LRU.
 */
const MAX_TRACKED_KEYS = 20_000;

/** Lazy sweep cadence: cost is amortised over this many `consume` calls. */
const SWEEP_EVERY_CALLS = 500;

interface WindowState {
  /** Start of the current fixed window, epoch ms, aligned to `windowMs`. */
  windowStart: number;
  currentCount: number;
  previousCount: number;
  /** The window length these counts were recorded with; a change resets them. */
  windowMs: number;
}

/**
 * In-process sliding window counter. Not exported: construct it through
 * {@link getRateLimiter} so there is exactly one per process.
 */
class MemoryRateLimiter implements RateLimiter {
  /**
   * Insertion order doubles as LRU order: every touched key is deleted and
   * re-set, so the oldest entry is always the first one the iterator yields.
   */
  private readonly states = new Map<string, WindowState>();
  private callsSinceSweep = 0;
  private warnedAboutCapacity = false;

  async consume(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitVerdict> {
    const now = Date.now();
    const { limit, windowMs } = policy;
    const storageKey = `${policy.name}:${key}`;
    const windowStart = Math.floor(now / windowMs) * windowMs;

    const state = this.rollForward(
      this.states.get(storageKey),
      windowStart,
      windowMs,
    );

    // Fraction of the current window already elapsed; the previous window's
    // count decays across it.
    const elapsed = (now - windowStart) / windowMs;
    const estimate = state.previousCount * (1 - elapsed) + state.currentCount;

    const allowed = estimate + 1 <= limit;
    if (allowed) {
      state.currentCount += 1;
    }

    // Re-inserting refreshes the LRU position even when the state object is
    // the same one we just read.
    this.states.delete(storageKey);
    this.states.set(storageKey, state);
    this.maintain(now);

    const resetAt = allowed
      ? windowStart + windowMs
      : this.recoveryTime(state, windowStart, windowMs, limit, now);

    return {
      allowed,
      limit,
      remaining: allowed ? Math.max(0, Math.floor(limit - estimate - 1)) : 0,
      resetAt,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  /**
   * Advances a stored state to the current window: one window on rotates the
   * counts, two or more means the key went quiet and starts clean. A changed
   * `windowMs` (a retuned policy, or a redeployed process) invalidates the
   * counts entirely — mixing window lengths would produce nonsense estimates.
   */
  private rollForward(
    state: WindowState | undefined,
    windowStart: number,
    windowMs: number,
  ): WindowState {
    if (!state || state.windowMs !== windowMs) {
      return { windowStart, currentCount: 0, previousCount: 0, windowMs };
    }
    const windowsElapsed = Math.round(
      (windowStart - state.windowStart) / windowMs,
    );
    if (windowsElapsed <= 0) {
      return state;
    }
    if (windowsElapsed === 1) {
      state.previousCount = state.currentCount;
    } else {
      state.previousCount = 0;
    }
    state.currentCount = 0;
    state.windowStart = windowStart;
    return state;
  }

  /**
   * Earliest moment the weighted estimate drops back under the limit.
   *
   * If the current window alone is already at the limit, nothing helps before
   * it ends. Otherwise the previous window's contribution has to decay far
   * enough, which happens partway through the current one.
   */
  private recoveryTime(
    state: WindowState,
    windowStart: number,
    windowMs: number,
    limit: number,
    now: number,
  ): number {
    const windowEnd = windowStart + windowMs;
    if (state.currentCount >= limit || state.previousCount <= 0) {
      return windowEnd;
    }
    // Need previousCount * (1 - elapsed) + currentCount + 1 <= limit.
    const headroom = (limit - 1 - state.currentCount) / state.previousCount;
    const elapsedNeeded = 1 - headroom;
    const at = windowStart + elapsedNeeded * windowMs;
    return Math.min(windowEnd, Math.max(now + 1000, at));
  }

  /**
   * Lazy housekeeping, run inline every {@link SWEEP_EVERY_CALLS} calls or
   * whenever the map is over capacity. Deliberately not a `setInterval`: a
   * timer would keep a reference to this map alive for the life of the process
   * and fire in every worker, including ones serving no traffic.
   */
  private maintain(now: number): void {
    this.callsSinceSweep += 1;
    const overCapacity = this.states.size > MAX_TRACKED_KEYS;
    if (this.callsSinceSweep < SWEEP_EVERY_CALLS && !overCapacity) {
      return;
    }
    this.callsSinceSweep = 0;

    // A state is dead once its previous window can no longer contribute.
    for (const [storageKey, state] of this.states) {
      if (state.windowStart + 2 * state.windowMs <= now) {
        this.states.delete(storageKey);
      }
    }

    if (this.states.size <= MAX_TRACKED_KEYS) {
      return;
    }

    if (!this.warnedAboutCapacity) {
      this.warnedAboutCapacity = true;
      console.error(
        `[security] Rate limiter at capacity (${MAX_TRACKED_KEYS} keys); evicting least-recently-used entries. Logged once per process.`,
      );
    }
    for (const storageKey of this.states.keys()) {
      if (this.states.size <= MAX_TRACKED_KEYS) {
        break;
      }
      this.states.delete(storageKey);
    }
  }
}

/**
 * Parked on `globalThis` for the same reason the Prisma client is: Turbopack
 * replaces module instances on every edit in dev, and a fresh limiter each time
 * would make the limits untestable locally. It also keeps Route Handlers and
 * Server Actions on one counter even if Next bundles them separately.
 */
const globalForRateLimit = globalThis as unknown as {
  pennySqueezeAdminRateLimiter?: RateLimiter;
};

/** The process-wide limiter. Replace the constructor here to go distributed. */
export function getRateLimiter(): RateLimiter {
  globalForRateLimit.pennySqueezeAdminRateLimiter ??= new MemoryRateLimiter();
  return globalForRateLimit.pennySqueezeAdminRateLimiter;
}

/**
 * Consumes one unit against `key` and refuses the request when the policy is
 * exhausted.
 *
 * Keys are namespaced by the caller, not by this function: use a prefix that
 * says what the key *is* (`ip:1.2.3.4`, `user:<sub>`, `login:email:<address>`)
 * so two policies can never be confused for one another.
 *
 * @throws {TooManyRequestsError} 429 with `Retry-After` when the limit is hit.
 */
export async function enforceRateLimit(
  key: string,
  policy: RateLimitPolicy,
): Promise<RateLimitVerdict> {
  const verdict = await getRateLimiter().consume(key, policy);
  if (!verdict.allowed) {
    throw new TooManyRequestsError(verdict.retryAfterSeconds, {
      limit: verdict.limit,
      remaining: verdict.remaining,
      resetAt: verdict.resetAt,
    });
  }
  return verdict;
}
