import "server-only";
/**
 * Shared-secret authentication for machine clients.
 *
 * This exists for callers that have no user: cron jobs, webhook senders,
 * internal services. It is deliberately *not* an alternative to the Cognito
 * session for anything a browser talks to — a key shipped to a browser is a
 * public key, and an endpoint "protected" by one is a public endpoint. See
 * `.claude/rules/api.md`.
 *
 * Keys come from `API_KEYS`, comma-separated so a rotation can keep the old and
 * new key live at the same time. Nothing here ever logs, returns, or puts a key
 * in an error: the only identifier that leaves this module is an opaque
 * `keyId`, the first 8 hex characters of the key's SHA-256.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError, ServiceUnavailableError } from "./errors";

/**
 * Below this, a key is guessable and does not belong in an environment
 * variable. 32 characters of base64url is ~192 bits.
 */
const MIN_API_KEY_LENGTH = 32;

/** Identifies the calling service without revealing its credential. */
export interface ApiKeyClient {
  /** First 8 hex chars of SHA-256(key). Safe to log and to use as a limit key. */
  keyId: string;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Module-level so each misconfiguration is reported once, not once per request. */
let warnedAboutShortKeys = false;
let warnedAboutMissingKeys = false;

interface ParsedKeys {
  /** SHA-256 digests of the configured keys; the keys themselves are dropped. */
  digests: Buffer[];
}

/**
 * Parsing on every call would rehash the configured keys on every request, so
 * the result is cached against the raw environment string: still lazy (nothing
 * is read at import time), still correct if the variable is ever swapped.
 */
let cache: { raw: string; parsed: ParsedKeys } | null = null;

function loadKeys(): ParsedKeys {
  const raw = process.env.API_KEYS ?? "";
  if (cache && cache.raw === raw) {
    return cache.parsed;
  }

  const candidates = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const usable = candidates.filter(
    (entry) => entry.length >= MIN_API_KEY_LENGTH,
  );

  if (usable.length !== candidates.length && !warnedAboutShortKeys) {
    warnedAboutShortKeys = true;
    console.error(
      `[security] Ignoring ${candidates.length - usable.length} API_KEYS entr${
        candidates.length - usable.length === 1 ? "y" : "ies"
      } shorter than ${MIN_API_KEY_LENGTH} characters. Logged once per process.`,
    );
  }

  const parsed: ParsedKeys = { digests: usable.map(sha256) };
  cache = { raw, parsed };
  return parsed;
}

/** Reads the presented key from `x-api-key` or `Authorization: ApiKey <key>`. */
function presentedKey(request: Request): string | null {
  const direct = request.headers.get("x-api-key")?.trim();
  if (direct) {
    return direct;
  }

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) {
    return null;
  }
  const [scheme, ...rest] = authorization.split(/\s+/);
  if (scheme.toLowerCase() !== "apikey" || rest.length !== 1) {
    return null;
  }
  return rest[0];
}

/**
 * Authenticates a machine caller.
 *
 * Comparison is over SHA-256 digests with `timingSafeEqual`, so neither the
 * length nor a shared prefix of a configured key leaks through response timing,
 * and every configured key is checked (no early exit) so the position of the
 * matching key does not either.
 *
 * @throws {ServiceUnavailableError} 503 `api_keys_not_configured` when no usable
 * key is configured. Failing closed is the point: an unconfigured deployment
 * must not silently expose a machine endpoint to everyone.
 * @throws {ApiError} 401 `invalid_api_key` when the key is missing or wrong.
 * The two cases share one message on purpose.
 */
export function requireApiKey(request: Request): ApiKeyClient {
  const { digests } = loadKeys();

  if (digests.length === 0) {
    if (!warnedAboutMissingKeys) {
      warnedAboutMissingKeys = true;
      console.error(
        "[security] API_KEYS is empty or unset; refusing every service request. Logged once per process.",
      );
    }
    throw new ServiceUnavailableError(
      "api_keys_not_configured",
      "This endpoint is not available.",
    );
  }

  const presented = presentedKey(request);
  if (!presented) {
    throw new ApiError(401, "invalid_api_key", "Invalid or missing API key.");
  }

  const digest = sha256(presented);
  let matched = false;
  for (const candidate of digests) {
    // Both operands are 32-byte SHA-256 digests, so the lengths always match
    // and `timingSafeEqual` cannot throw.
    matched = timingSafeEqual(digest, candidate) || matched;
  }

  if (!matched) {
    throw new ApiError(401, "invalid_api_key", "Invalid or missing API key.");
  }

  return { keyId: digest.toString("hex").slice(0, 8) };
}
