import "server-only";
/**
 * The `cognito_directory` run: the nightly record of what the customer
 * Cognito pool looks like, what changed since last night, and what the pool's
 * own counters say.
 *
 * **Why a job at all.** Cognito is not a system of record for history. It
 * will tell you who is in the pool right now, and that is all: there is no
 * event and no Lambda trigger for a deletion or a disablement, and on the
 * Essentials tier there is no per-user activity either. An account removed
 * yesterday is simply absent from today's answer, with nothing saying it ever
 * existed. So the console keeps its own history — one snapshot a night — and
 * **the difference between two snapshots is the event log**. Everything the
 * Activity view says about churn, confirmations and disablements is derived
 * from that difference, which is why the diff below is careful about the three
 * cases that could corrupt it — a truncated listing, an empty listing, and a
 * listing that lost most of the pool overnight — and refuses to run on any of
 * them.
 *
 * **What one run costs.** Nothing. `ListUsers` and `GetMetricData` are both
 * free, and there is no equivalent of Cost Explorer's per-request charge
 * anywhere on this path. "Run now" from the Integrations page is therefore
 * safe to press, unlike the AWS costs run — and useful, because it is how an
 * operator takes a snapshot immediately after a change they made by hand.
 *
 * **The four parts, in order.**
 *
 * 1. *Snapshot.* Page the whole pool and write today's rows.
 * 2. *Diff.* Compare with the most recent previous **complete** snapshot day
 *    (a day whose listing was cut short is marked `partial` and skipped) and
 *    record `deleted`, `disabled`, `enabled`, `confirmed` and `reappeared` —
 *    unless the change between the two days is too large to be believable,
 *    which fails the run instead (see {@link diffRefusal}).
 * 3. *Metrics.* One `GetMetricData` call for the pool's daily counters.
 * 4. *Main-database sweep.* Record `deleted_in_app` for anyone the consumer
 *    app soft-deleted in the last week, so a self-service deletion is counted
 *    as churn the same night rather than waiting for the pool clean-up.
 *
 * Each part is committed before the next begins, so a run interrupted half
 * way leaves everything it had already learned. Parts 3 and 4 do not depend
 * on 1 or 2 and still happen when the diff was skipped.
 *
 * **What the counters mean here.** Like `aws-costs.ts`, this run does not
 * process a list of items, so the counters are given a meaning and the
 * meaning is stated:
 *
 * - `total` is the parts the run planned (always 4);
 * - `processed` is the parts that finished, whether they achieved anything or
 *   refused;
 * - `failed` is the parts that refused for a reason worth an operator's
 *   attention. "This does not apply" — no previous snapshot to diff against,
 *   no CloudWatch permission on a deployment that never had one — is a skip,
 *   not a failure;
 * - `created` is **rows written**: snapshot rows, plus event rows, plus new
 *   metric days;
 * - `updated` is metric days that replaced an earlier reading;
 * - `unchanged` is the accounts the diff found nothing to say about, which is
 *   the healthy majority every night.
 *
 * **Failure.** A pool that cannot be listed fails the run immediately: with
 * no snapshot there is nothing to diff and the whole point of the run is
 * gone. Anything after that is folded into the counters and rethrown at the
 * very end, after the writes, so a run that got the snapshot but not the
 * metrics still leaves the snapshot behind.
 */
import { fetchPoolMetrics } from "@/lib/customers/cloudwatch";
import { listPoolAccounts } from "@/lib/customers/cognito";
import {
  previousSnapshotDay,
  recordEvents,
  snapshotFor,
  subsWithEvent,
  upsertPoolMetrics,
  writeSnapshot,
  type EventWrite,
  type SnapshotState,
} from "@/lib/customers/lifecycle";
import { findRecentlyDeletedUsers } from "@/lib/customers/repository";
import {
  DELETED_IN_APP_LOOKBACK_DAYS,
  DELETED_IN_APP_MAX,
} from "@/lib/customers/types";
import type { RunWork } from "../runs";

export interface CognitoDirectoryRunContext {
  /** Days of CloudWatch counters the run re-fetches, ending yesterday. */
  metricsDays: number;
  /**
   * The instant the run treats as "now". Injected only by a test or an
   * ad-hoc check; production leaves it alone.
   */
  now?: Date;
}

/** The parts a run plans, in order. `total` is this many. */
const PARTS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` for a UTC instant. */
function dayLabel(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * A drop this large between two snapshots is treated as a bad listing rather
 * than as news.
 *
 * Both conditions have to hold, because either alone is ordinary: a pool of
 * three accounts that loses two is a 67 % drop and completely normal, and
 * twenty departures out of two thousand is a busy week. Together — most of
 * the pool, and more than a couple of dozen accounts — they describe
 * something the product cannot do to itself overnight, and the likeliest
 * cause is that `CUSTOMER_COGNITO_USER_POOL_ID` now names a different (or
 * emptier) pool than it did last night.
 */
const DIFF_DROP_SHARE_MAX = 0.5;
const DIFF_DROP_ACCOUNTS_MIN = 20;

/**
 * Why the diff must be refused, or `null` when it may go ahead.
 *
 * The diff's `deleted` rule is "a sub was here yesterday and is not today",
 * which is exactly what a *wrong* pool looks like as well. A snapshot of the
 * wrong pool would therefore write a `deleted` event for every real account,
 * and those events are permanent: they are the churn figures, and nothing
 * later can tell them from real departures. So the shape of the change is
 * checked before it is believed, and a change too large to be real fails the
 * run with the variable to look at named.
 *
 * A truncated listing is caught by the caller before this is reached — it has
 * its own message, and it is about the cap rather than about the pool.
 *
 * Pure, and exported for the same reason `diffSnapshots` is: these are the
 * rules that decide what goes in the event log, and they should be readable
 * without a pool or a database in the way.
 */
export function diffRefusal(previousCount: number, currentCount: number): string | null {
  if (previousCount === 0) return null;
  if (currentCount === 0) {
    return (
      `the pool listing came back empty while the previous snapshot held ${previousCount} ` +
      "accounts, so the diff was refused — every one of them would have been recorded as " +
      "deleted. Check CUSTOMER_COGNITO_USER_POOL_ID and that the deployment's credentials " +
      "still allow cognito-idp:ListUsers on that pool."
    );
  }
  const dropped = previousCount - currentCount;
  if (dropped > DIFF_DROP_ACCOUNTS_MIN && dropped > previousCount * DIFF_DROP_SHARE_MAX) {
    const share = Math.round((dropped / previousCount) * 100);
    return (
      `the pool listing holds ${currentCount} accounts where the previous snapshot held ` +
      `${previousCount} — ${dropped} fewer (${share} %), which is more than ` +
      `${Math.round(DIFF_DROP_SHARE_MAX * 100)} % and more than ${DIFF_DROP_ACCOUNTS_MIN} ` +
      "accounts, so the diff was refused rather than recording that many deletions. Check " +
      "CUSTOMER_COGNITO_USER_POOL_ID; if the drop is real, run the job again once the next " +
      "snapshot has narrowed the gap, or delete the stale snapshot day by hand."
    );
  }
  return null;
}

/**
 * The events two snapshot days imply.
 *
 * Pure, and separated from every database call on purpose: these five rules
 * are the whole feature's definition of what happened to an account, and they
 * are worth being able to read — and check by hand — without a pool or a
 * database in the way.
 *
 * The rules, exactly:
 *
 * - a sub in `previous` and not in `current` → **deleted**. Whoever removed
 *   it, including the AWS console;
 * - `enabled` true → false → **disabled**; false → true → **enabled**;
 * - status `force_change_password` → `confirmed` → **confirmed**: the person
 *   set their own password. Only that transition, not "is now confirmed",
 *   because the latter would fire for an account that was already confirmed
 *   when snapshots began;
 * - a sub in `current` and not in `previous` → **reappeared**. Not "new": a
 *   genuinely new account also looks like this, and so does a night the job
 *   did not run. The event name says what is certain — this sub was not here
 *   and now is — and `invited` (written by the console at the moment it
 *   creates an account) is what marks a real arrival. Signups are counted
 *   from `users.created_at` instead, which cannot be confused by a missed
 *   night.
 *
 * Every event is dated at 00:00 UTC of the snapshot day, which is what makes
 * a repeated run a no-op against `UNIQUE (sub, event, at)`. It also says
 * something true: the diff knows the change happened *by* this snapshot, not
 * when.
 */
export function diffSnapshots(
  previous: readonly SnapshotState[],
  current: readonly SnapshotState[],
  at: Date,
): { events: EventWrite[]; unchanged: number } {
  const before = new Map(previous.map((row) => [row.sub, row]));
  const after = new Map(current.map((row) => [row.sub, row]));
  const events: EventWrite[] = [];
  let unchanged = 0;

  for (const [sub, was] of before) {
    const is = after.get(sub);
    if (is === undefined) {
      events.push({
        sub,
        event: "deleted",
        at,
        source: "directory_diff",
        details: { email: was.email, lastStatus: was.status, lastEnabled: was.enabled },
      });
      continue;
    }
    let changed = false;
    if (was.enabled && !is.enabled) {
      events.push({
        sub,
        event: "disabled",
        at,
        source: "directory_diff",
        details: { email: is.email, status: is.status },
      });
      changed = true;
    } else if (!was.enabled && is.enabled) {
      events.push({
        sub,
        event: "enabled",
        at,
        source: "directory_diff",
        details: { email: is.email, status: is.status },
      });
      changed = true;
    }
    if (was.status === "force_change_password" && is.status === "confirmed") {
      events.push({
        sub,
        event: "confirmed",
        at,
        source: "directory_diff",
        details: { email: is.email, from: was.status, to: is.status },
      });
      changed = true;
    }
    if (!changed) unchanged += 1;
  }

  for (const [sub, is] of after) {
    if (before.has(sub)) continue;
    events.push({
      sub,
      event: "reappeared",
      at,
      source: "directory_diff",
      details: { email: is.email, status: is.status, enabled: is.enabled },
    });
  }

  return { events, unchanged };
}

export function cognitoDirectoryWork(context: CognitoDirectoryRunContext): RunWork {
  return async (report) => {
    const now = context.now ?? new Date();
    const today = dayLabel(now);
    const yesterday = dayLabel(new Date(now.getTime() - DAY_MS));
    const metricsFrom = dayLabel(new Date(now.getTime() - context.metricsDays * DAY_MS));

    let processed = 0;
    let failed = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const outcomes: Record<string, string> = {};
    const errors: string[] = [];

    const progress = () =>
      report({ total: PARTS, processed, created, updated, unchanged, failed });

    await progress();

    /* ---------------------------- (1) The snapshot ------------------------ */

    // Not wrapped: without a snapshot there is nothing to diff, and the diff
    // is the reason the job exists. The error the pool threw is already a
    // sentence an operator can act on (`translateCognitoError`), so it is
    // allowed to end the run.
    const listing = await listPoolAccounts();
    const snapshot = await writeSnapshot(
      today,
      listing.accounts.map((account) => ({
        sub: account.sub,
        status: account.status,
        enabled: account.enabled,
        poolCreatedAt: account.createdAt,
        poolUpdatedAt: account.updatedAt,
        email: account.email,
      })),
      // A listing cut short by the page cap is written, but marked: the day it
      // produced must never become the previous side of a later diff, or every
      // account it did not reach would be recorded as deleted tomorrow night.
      { partial: listing.truncated },
    );
    created += snapshot.written;
    processed += 1;
    outcomes.snapshot =
      `ok: ${snapshot.written} accounts on ${today}` +
      (snapshot.removed > 0 ? `, replacing ${snapshot.removed} from an earlier run today` : "") +
      (listing.withoutSub > 0 ? `, ${listing.withoutSub} skipped with no sub attribute` : "") +
      (listing.truncated ? ", recorded as a partial day (the listing was cut short)" : "");
    await progress();

    /* ------------------------------- (2) The diff ------------------------- */

    if (listing.truncated) {
      // The one case that must never be diffed. A listing cut short by the
      // page cap is missing accounts it never reached, and every one of them
      // would look deleted — writing thousands of false `deleted` events and
      // corrupting every churn figure that follows. The snapshot is kept
      // (partial data is still data) and the diff is refused loudly.
      failed += 1;
      processed += 1;
      const message =
        `the pool listing was cut short at ${listing.pages} pages, so the snapshot is ` +
        "incomplete and was not diffed — every account the listing did not reach would " +
        "have been recorded as deleted. The day is marked partial, so tomorrow's diff will " +
        "skip it rather than diff against it. Raise LIST_PAGE_CAP in " +
        "src/lib/customers/cognito.ts or move to a per-sub lookup.";
      outcomes.diff = `failed: ${message}`;
      errors.push(`diff: ${message}`);
      await progress();
    } else {
      const previousDay = await previousSnapshotDay(today);
      if (previousDay === null) {
        // The first snapshot ever. There is nothing to compare with, and
        // treating every existing account as an arrival would invent a
        // month's worth of signups on the night the feature was switched on.
        processed += 1;
        outcomes.diff = "skipped: this is the first snapshot, so there is nothing to compare with";
        await progress();
      } else {
        const previous = await snapshotFor(previousDay);
        // Checked before the diff is believed: a pool that lost most of its
        // accounts overnight is far more likely to be a pool id that changed
        // than a product that emptied, and a `deleted` event is permanent.
        // The snapshot above is already committed either way.
        const refusal = diffRefusal(previous.length, listing.accounts.length);
        if (refusal !== null) {
          failed += 1;
          processed += 1;
          outcomes.diff = `failed: ${refusal}`;
          errors.push(`diff: ${refusal}`);
          await progress();
        } else {
          const { events, unchanged: quiet } = diffSnapshots(
            previous,
            listing.accounts.map((account) => ({
              sub: account.sub,
              status: account.status,
              enabled: account.enabled,
              email: account.email,
            })),
            // Midnight UTC of the snapshot day: deterministic, so a re-run
            // writes nothing new.
            new Date(`${today}T00:00:00.000Z`),
          );
          const written = await recordEvents(events);
          created += written;
          unchanged += quiet;
          processed += 1;
          outcomes.diff =
            `ok: ${previousDay} -> ${today}, ${events.length} changes ` +
            `(${written} new events, ${quiet} accounts unchanged)`;
          await progress();
        }
      }
    }

    /* ----------------------------- (3) Pool metrics ----------------------- */

    try {
      const metrics = await fetchPoolMetrics(metricsFrom, yesterday);
      const outcome = await upsertPoolMetrics(metrics.rows);
      created += outcome.created;
      updated += outcome.updated;
      processed += 1;

      /* What CloudWatch did not say is as important as what it did. An empty
         answer is the failure mode this path is prone to — the `AWS/Cognito`
         series are published per app client, so a query that names the pool
         alone matches nothing and answers "no data" rather than failing — and
         "no data" is indistinguishable from a pool nobody signed in to. So:

         - a `StatusCode` other than `Complete`, and anything in `Messages`,
           are always reported. They never arrive as an exception;
         - *every* query empty is only treated as a fault when the pool has at
           least one confirmed account. A pool of invitations nobody has
           accepted really does produce no sign-ins, and a young deployment
           must not be told its metrics are broken when they are merely
           quiet. */
      const confirmed = listing.accounts.filter((account) => account.status === "confirmed").length;
      const faults: string[] = [];
      if (metrics.incomplete.length > 0) {
        faults.push(`CloudWatch did not complete ${metrics.incomplete.join(", ")}`);
      }
      if (metrics.messages.length > 0) {
        faults.push(`CloudWatch said: ${metrics.messages.join("; ")}`);
      }
      if (metrics.truncated) {
        faults.push(
          "the answer had more pages than the read allows (MAX_PAGES in " +
            "src/lib/customers/cloudwatch.ts), so the window is incomplete",
        );
      }
      if (metrics.allEmpty && confirmed > 0) {
        faults.push(
          `every metric query came back empty for ${metricsFrom}..${yesterday} while the pool ` +
            `holds ${confirmed} confirmed ${confirmed === 1 ? "account" : "accounts"}. The ` +
            "AWS/Cognito series are published per app client (dimensions UserPool + " +
            "UserPoolClient) and are read with a SEARCH expression over both; an empty answer " +
            "means the search matched nothing — check CUSTOMER_COGNITO_USER_POOL_ID, that " +
            "CUSTOMER_COGNITO_REGION is the pool's own region, and that the task role allows " +
            "cloudwatch:GetMetricData",
        );
      }

      const summary =
        `${metrics.rows.length} days from ${metricsFrom} to ${yesterday} ` +
        `(${outcome.created} new, ${outcome.updated} refreshed)` +
        (metrics.unanswered.length === 0
          ? ""
          : `; no figure for ${metrics.unanswered.join(", ")}`);

      if (faults.length === 0) {
        outcomes.poolMetrics = `ok: ${summary}`;
      } else {
        // One failed part however many faults it had: `failed` counts parts,
        // and the sentence carries all of them.
        failed += 1;
        const message = `${summary} — ${faults.join(". ")}`;
        outcomes.poolMetrics = `failed: ${message}`;
        errors.push(`poolMetrics: ${message}`);
      }
      await progress();
    } catch (error) {
      processed += 1;
      const message = messageOf(error);
      if (isPermissionFailure(error)) {
        // A deployment whose task role predates this feature simply cannot
        // read CloudWatch. That is a configuration gap an operator closes in
        // infra/service-admin.yaml, not a failure of tonight's run: the
        // snapshot and the diff — the parts that cannot be recovered later —
        // are already committed and the metrics can be backfilled once the
        // permission is there.
        outcomes.poolMetrics =
          `skipped: AWS refused cloudwatch:GetMetricData (${message}). The task role needs ` +
          "cloudwatch:GetMetricData on \"*\"; see infra/service-admin.yaml. Everything else in " +
          "this run is unaffected.";
      } else {
        failed += 1;
        outcomes.poolMetrics = `failed: ${message}`;
        errors.push(`poolMetrics: ${message}`);
      }
      await progress();
    }

    /* ------------------------ (4) Deletions in the app -------------------- */

    try {
      const since = new Date(now.getTime() - DELETED_IN_APP_LOOKBACK_DAYS * DAY_MS);
      const deleted = await findRecentlyDeletedUsers(since, DELETED_IN_APP_MAX);
      const already = await subsWithEvent("deleted_in_app", deleted.map((user) => user.cognitoSub));
      const events: EventWrite[] = deleted
        .filter((user) => !already.has(user.cognitoSub))
        .map((user) => ({
          sub: user.cognitoSub,
          event: "deleted_in_app" as const,
          // The deletion's own timestamp, not tonight's: the month the
          // departure belongs to is the month it happened in, and dating it
          // here would move a deletion made on the 31st into the next month.
          // It is also what makes the unique key idempotent for this path.
          at: user.deletedAt,
          source: "main_db" as const,
          details: { email: user.email, userId: user.id },
        }));
      const written = await recordEvents(events);
      created += written;
      processed += 1;
      outcomes.deletedInApp =
        `ok: ${deleted.length} deletions in the last ${DELETED_IN_APP_LOOKBACK_DAYS} days, ` +
        `${written} newly recorded` +
        // Not a failure — the sweep runs every night and the window is seven
        // days long — but the operator should see it in the run, not only in
        // the server log the repository writes.
        (deleted.length >= DELETED_IN_APP_MAX
          ? `; the read stopped at its cap of ${DELETED_IN_APP_MAX}, so older deletions in the window were not seen`
          : "");
      await progress();
    } catch (error) {
      processed += 1;
      failed += 1;
      const message = messageOf(error);
      outcomes.deletedInApp = `failed: ${message}`;
      errors.push(`deletedInApp: ${message}`);
      await progress();
    }

    console.info(
      `[integrations] cognito_directory: ${processed}/${PARTS} parts, ` +
        `${listing.accounts.length} accounts snapshotted on ${today}, ` +
        `${created} rows written` +
        (failed === 0 ? "" : `, ${failed} parts failed`),
    );

    // Everything achieved is already committed, so reporting what went wrong
    // costs none of it. A run with a failed part is a failed run: the page
    // would otherwise show last night's figures under a green tick.
    if (errors.length > 0) {
      throw new Error(
        `${errors.length} of ${PARTS} parts failed — ${errors.join("; ")}`,
      );
    }
  };
}

/** The last line of an error, which is what a run's `error` column should hold. */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return (error.message.split("\n").filter((line) => line.trim() !== "").at(-1) ?? error.message).trim();
  }
  return String(error);
}

/**
 * True when AWS refused the call because of credentials or IAM.
 *
 * Kept local rather than imported from `src/lib/costs/aws.ts`: that module's
 * classifier is about Cost Explorer's vocabulary and pulls in three AWS
 * clients with it, and the decision here is a different one — a missing
 * CloudWatch permission is a *skip* for this run, where a missing `ce:*`
 * permission is fatal for that one.
 */
function isPermissionFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return (
    name === "AccessDenied" ||
    name === "AccessDeniedException" ||
    name === "CredentialsProviderError" ||
    name === "ExpiredToken" ||
    name === "ExpiredTokenException" ||
    name === "InvalidClientTokenId" ||
    name === "InvalidSignatureException" ||
    name === "UnrecognizedClientException" ||
    // CloudWatch's own spelling of "you may not do this".
    name === "AccessDeniedError"
  );
}
