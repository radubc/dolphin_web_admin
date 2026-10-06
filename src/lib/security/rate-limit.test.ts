/**
 * Unit tests for the in-process rate limiter (`./rate-limit`): charging and,
 * since the sign-in budgets count failed attempts only (owner, 2026-10-06),
 * refunding. The limiter is the real process-wide one, keyed by a fresh key
 * per test. Nothing here talks to AWS or a database.
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type * as RateLimit from "./rate-limit";

const { enforceRateLimit, getRateLimiter, refundRateLimit } = (await import(
  "./rate-limit" + ".ts"
)) as typeof RateLimit;

/** A small budget, so the tests reach the limit in a few calls. */
const POLICY: RateLimit.RateLimitPolicy = { name: "test_refund", limit: 3, windowMs: 15 * 60_000 };

/** A fresh key per test: the limiter is per process. */
function key(): string {
  return `test:${randomUUID()}`;
}

describe("refundRateLimit", () => {
  it("gives back the slot a charge took, so the next charge is allowed again", async () => {
    const k = key();
    for (let i = 0; i < POLICY.limit; i += 1) {
      await enforceRateLimit(k, POLICY);
    }
    const exhausted = await getRateLimiter().consume(k, POLICY);
    assert.equal(exhausted.allowed, false);

    await refundRateLimit(k, POLICY);

    const afterRefund = await getRateLimiter().consume(k, POLICY);
    assert.equal(afterRefund.allowed, true);
    assert.equal(afterRefund.remaining, 0);
  });

  it("refunds one slot per call, never more", async () => {
    const k = key();
    await enforceRateLimit(k, POLICY);
    await enforceRateLimit(k, POLICY);
    await refundRateLimit(k, POLICY);

    // Two charged, one refunded: one slot spent, limit - 1 - 1 left after this.
    const verdict = await enforceRateLimit(k, POLICY);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.remaining, POLICY.limit - 2);
  });

  it("is a no-op at zero: a never-charged key is not driven negative", async () => {
    const k = key();
    await refundRateLimit(k, POLICY);
    await refundRateLimit(k, POLICY);

    const verdict = await enforceRateLimit(k, POLICY);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.remaining, POLICY.limit - 1);
  });

  it("is a no-op at zero after charges were all refunded", async () => {
    const k = key();
    await enforceRateLimit(k, POLICY);
    await refundRateLimit(k, POLICY);
    await refundRateLimit(k, POLICY);

    const verdict = await enforceRateLimit(k, POLICY);
    assert.equal(verdict.remaining, POLICY.limit - 1);
  });

  it("leaves the window where it is", async () => {
    const k = key();
    const charged = await enforceRateLimit(k, POLICY);
    await refundRateLimit(k, POLICY);
    const again = await enforceRateLimit(k, POLICY);
    assert.equal(again.resetAt, charged.resetAt);
  });

  it("keys on the policy name too: a refund under another policy touches nothing", async () => {
    const k = key();
    const other: RateLimit.RateLimitPolicy = { ...POLICY, name: "test_refund_other" };
    await enforceRateLimit(k, POLICY);
    await refundRateLimit(k, other);

    const verdict = await enforceRateLimit(k, POLICY);
    assert.equal(verdict.remaining, POLICY.limit - 2);
  });
});
