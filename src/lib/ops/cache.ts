import "server-only";
/**
 * A sixty-second, in-process answer cache for the two AWS reads the Overview
 * does on every page load.
 *
 * Why it exists: the Overview is the page an operator lands on and the page
 * they leave open. `GetMetricData` and `DescribeServices` are free, but they
 * are still a round trip to AWS on every render, every navigation back to `/`
 * and every refresh. One minute is shorter than the resolution of anything on
 * the card — the metric period is an hour and a rollout takes minutes — so a
 * cached answer is never misleading, and the card prints the fetch time so
 * nobody has to guess.
 *
 * Deliberate properties:
 *
 * - **Failures are cached too.** A missing credential or a denied action does
 *   not fix itself inside a minute, and a page that retried on every render
 *   would turn one misconfiguration into a stream of failing calls. The wait
 *   after a fix is at most sixty seconds.
 * - **One flight at a time.** Concurrent renders share the in-flight promise,
 *   so a cold cache and three open tabs is still one AWS call.
 * - **Per process.** Two tasks keep two caches; that is the same trade the
 *   rate limiter makes and at this scale it is invisible.
 */

/** The window a cached answer is served for. */
export const OPS_CACHE_TTL_MS = 60_000;

/**
 * The socket budget both AWS clients in this folder are built with.
 *
 * The Overview is rendered on the server, so an AWS call that hangs does not
 * degrade a card — it holds the whole page's response open, and the 60-second
 * cache means the next render waits on the same stuck promise. A hung socket
 * must therefore fail fast and on its own: five seconds for the request, two
 * to get a connection, and `maxAttempts: 2` so one retry is allowed and a
 * throttled call cannot turn into a minute of back-off. Both numbers are far
 * above what these calls take when the account is reachable (tens of
 * milliseconds from Fargate in the same region) and far below any patience a
 * dashboard deserves.
 *
 * `requestHandler` is the constructor-arguments form the SDK accepts
 * (`NodeHttpHandlerOptions`), so no `@smithy/node-http-handler` import and no
 * handler instance to share between clients.
 */
export const OPS_CLIENT_TIMEOUTS = {
  requestHandler: { requestTimeout: 5_000, connectionTimeout: 2_000 },
  maxAttempts: 2,
} as const;

interface Slot<T> {
  value: T;
  at: number;
}

/**
 * Wraps `load` so it runs at most once per {@link OPS_CACHE_TTL_MS}.
 *
 * `load` must resolve rather than reject — both callers here catch their own
 * failures and return them as data — but a rejection is handled anyway: it
 * clears the flight and is not cached, so the next caller tries again.
 */
export function memoiseFor<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let slot: Slot<T> | null = null;
  let flight: Promise<T> | null = null;

  return async function read(): Promise<T> {
    const now = Date.now();
    if (slot !== null && now - slot.at < ttlMs) return slot.value;
    if (flight !== null) return flight;

    flight = load()
      .then((value) => {
        slot = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        flight = null;
      });

    return flight;
  };
}
