import "server-only";
/**
 * The `iso_mic_markets` run: downloads the ISO 10383 MIC register and inserts
 * the markets the admin `markets` catalog does not have yet.
 *
 * **Insert-only, on purpose**, exactly like `./catalogs.ts`. An existing row
 * is never updated and never deleted, whatever the register now says about
 * it: the catalog is referenced by tenant data on the consumer side, and a
 * venue that changed its published name or moved city upstream is not a
 * reason to rewrite a row someone's holdings point at. An operator who wants
 * a row changed does it on the Constants page.
 *
 * **Matching.** On `mic_code`, which is the catalog's unique key and the
 * register's own identifier. Both sides are upper-cased before they are
 * compared, so a row inserted by hand in lower case still counts as present
 * rather than becoming a duplicate the unique index would refuse.
 *
 * **Soft-deleted rows count as present.** The unique index on `mic_code` does
 * not care about `deleted_at`, so a MIC an operator retired must not be
 * inserted again — it would simply fail. The retirement is the operator's
 * decision and this run does not overturn it.
 *
 * **Size.** About 2 900 rows and 600 KB: small enough to hold in memory, and
 * the batching (500) exists for the commit boundary and the heartbeat rather
 * than for the memory.
 *
 * **The ledger.** Rows this run inserts are marked `new` in the Constants
 * sync ledger (`upsertStates`), which is what makes them show up on the
 * Constants page as pending a push to the main app database. Nothing here
 * pushes anything.
 */
import { randomUUID } from "node:crypto";
import { upsertStates, type LedgerEntry } from "@/lib/constants/ledger";
import { prismaAdmin } from "@/lib/prisma-admin";
import { fetchMicRegister, isLoadableMic, type MicRow } from "../providers/iso-mic";
import type { RunProgress, RunWork } from "../runs";

/** Rows per `createMany`, and therefore per commit and per heartbeat. */
const INSERT_BATCH = 500;

/** Rows per read while loading the MICs the catalog already holds. */
const KEY_SCAN_BATCH = 5000;

/**
 * Every `mic_code` the catalog already holds, upper-cased, read in cursored
 * batches. Soft-deleted rows are included: see the note above.
 */
async function existingMicCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  let after = "";
  for (;;) {
    const rows = await prismaAdmin.markets.findMany({
      where: { id: { gt: after } },
      select: { id: true, mic_code: true },
      orderBy: { id: "asc" },
      take: KEY_SCAN_BATCH,
    });
    if (rows.length === 0) return codes;
    for (const row of rows) codes.add(row.mic_code.trim().toUpperCase());
    after = rows[rows.length - 1].id;
    if (rows.length < KEY_SCAN_BATCH) return codes;
  }
}

export interface MarketsRunContext {
  baseUrl: string;
  /** Load the register's EXPIRED rows too. False by default. */
  includeExpired: boolean;
}

/**
 * The run body.
 *
 * - `total` — rows the register published that this run considers (after the
 *   status filter, so the figure matches what the run set out to do)
 * - `processed` — rows examined
 * - `created` — markets inserted
 * - `unchanged` — rows the catalog already had, or a MIC the register listed
 *   twice
 * - `failed` — always 0: a row that cannot be used is dropped by the parser
 *   before it reaches here
 */
export function marketsWork(context: MarketsRunContext): RunWork {
  return async (report) => {
    const counters: Required<Pick<RunProgress, "processed" | "created" | "unchanged" | "failed">> =
      { processed: 0, created: 0, unchanged: 0, failed: 0 };

    console.info("[integrations] markets: downloading the ISO 10383 MIC register");
    const published = await fetchMicRegister(context.baseUrl);
    const rows = published.filter((row) => isLoadableMic(row, context.includeExpired));
    const total = rows.length;
    console.info(
      `[integrations] markets: ${published.length} published, ${total} loadable ` +
        `(expired ${context.includeExpired ? "included" : "excluded"})`,
    );
    await report({ total, ...counters });

    const known = await existingMicCodes();
    const seen = new Set<string>();
    const pending: (MicRow & { id: string })[] = [];

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const now = new Date();
      // `skipDuplicates` is belt and braces: the key set already filtered
      // these, but another process inserting the same MIC between the scan
      // and this statement must not fail the whole batch.
      const created = await prismaAdmin.markets.createManyAndReturn({
        data: pending.map((row) => ({
          id: row.id,
          mic_code: row.mic_code,
          operating_mic: row.operating_mic,
          market_name: row.market_name,
          iso_country_code: row.iso_country_code,
          city: row.city,
          created_at: now,
          updated_at: now,
        })),
        skipDuplicates: true,
        select: { id: true },
      });
      counters.created += created.length;
      // Rows the batch did not create were taken by someone else in between;
      // from the catalog's side they are unchanged.
      counters.unchanged += pending.length - created.length;
      pending.length = 0;
      const entries: LedgerEntry[] = created.map((row) => ({ id: row.id, state: "new" }));
      await upsertStates("markets", entries);
      await report({ total, ...counters });
    };

    for (const row of rows) {
      counters.processed += 1;
      const code = row.mic_code;
      if (known.has(code) || seen.has(code)) {
        counters.unchanged += 1;
        continue;
      }
      seen.add(code);
      pending.push({
        id: randomUUID(),
        mic_code: row.mic_code,
        operating_mic: row.operating_mic,
        market_name: row.market_name,
        iso_country_code: row.iso_country_code,
        city: row.city,
      });
      if (pending.length >= INSERT_BATCH) await flush();
    }
    await flush();

    await report({ total, ...counters });
    console.info(
      `[integrations] markets: done — ${counters.created} created, ` +
        `${counters.unchanged} already present`,
    );
  };
}
