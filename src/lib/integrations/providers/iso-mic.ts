/**
 * ISO 20022: the ISO 10383 Market Identifier Code register.
 *
 * One published CSV, no key and no quota — the whole list of exchanges,
 * trading venues and reporting services in the world, about 2 900 rows and
 * 600 KB. It is the authoritative source for the four columns the admin
 * `markets` catalog holds (`mic_code`, `operating_mic`, `market_name`,
 * `iso_country_code`, `city`), which is why this integration exists at all:
 * the catalog is otherwise empty and nothing else the app talks to publishes
 * MICs.
 *
 * Fetch and parse only — no Prisma and no run bookkeeping, so the parsing
 * rules can be read on their own (`../jobs/markets.ts` is the run body).
 *
 * ## Why a parser here rather than a package
 *
 * The file is RFC 4180 in the strictest sense — every field quoted, commas
 * and doubled `""` inside fields, CRLF line endings — and that is thirty
 * lines of state machine. A dependency for it would be a supply-chain
 * decision taken for thirty lines. `parseCsv` below is that state machine and
 * nothing else: it does not guess delimiters, it does not coerce types and it
 * does not skip blank fields.
 *
 * ## Status
 *
 * The register marks each row ACTIVE (a live MIC), UPDATED (live, changed at
 * the last release) or EXPIRED (retired). Both live states are loaded;
 * EXPIRED only when `settings.includeExpired` says so, because an expired
 * market is history and the catalog is a list of places one can hold a
 * position.
 */
import { ProviderError, fetchText, redactUrl, toText } from "./http";

/** ~600 KB over a plain CDN; generous, but a hung socket must not pin a run. */
export const MIC_TIMEOUT_MS = 120_000;

/**
 * The register's path under the integration's base URL. Stored nowhere: the
 * base URL is the editable part, the path is the code's business.
 */
export const MIC_CSV_PATH = "/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv";

/* -------------------------------------------------------------------------- */
/*                                 CSV parsing                                */
/* -------------------------------------------------------------------------- */

/**
 * RFC 4180, as a state machine over the whole text.
 *
 * The rules it implements, all of which the MIC file exercises:
 * - a field may be quoted; inside quotes a comma, a CR and an LF are data;
 * - `""` inside a quoted field is one literal double quote;
 * - a record ends at CRLF or LF **outside** quotes (a lone CR is treated as a
 *   record end too, so an old-Mac export does not become one giant row);
 * - a trailing newline does not produce an extra empty record.
 *
 * Returns rows of raw strings. Nothing is trimmed here — trimming is the
 * caller's decision, and a market name really can end in a space.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  /** True once anything at all has been seen for the current record. */
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote is one literal quote; a single one closes the field.
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ",") {
      started = true;
      endField();
      continue;
    }
    if (char === "\r") {
      // CRLF and a lone CR both end the record; the LF is consumed with it.
      if (text[index + 1] === "\n") index += 1;
      endRow();
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }
    started = true;
    field += char;
  }

  // A file that ends without a newline still has one last record; a file that
  // ends with one must not gain an empty row.
  if (started || field !== "" || row.length > 0) endRow();
  return rows;
}

/* -------------------------------------------------------------------------- */
/*                                  The rows                                  */
/* -------------------------------------------------------------------------- */

/** A `markets` row as the admin catalog stores it. Empty strings, never null. */
export interface MicRow {
  mic_code: string;
  operating_mic: string;
  market_name: string;
  iso_country_code: string;
  city: string;
}

/** The register's own lifecycle value. */
export type MicStatus = "ACTIVE" | "UPDATED" | "EXPIRED" | "UNKNOWN";

export interface ParsedMic extends MicRow {
  status: MicStatus;
}

/**
 * The header names this parser reads, exactly as the register spells them.
 * Matched by name rather than by position: the register has added columns
 * before (LEI, the validation dates) and a positional reader would silently
 * shift.
 */
const HEADERS = {
  mic: "MIC",
  operatingMic: "OPERATING MIC",
  name: "MARKET NAME-INSTITUTION DESCRIPTION",
  country: "ISO COUNTRY CODE (ISO 3166)",
  city: "CITY",
  status: "STATUS",
} as const;

/** Header name → column index, upper-cased and trimmed so spacing cannot matter. */
function indexHeader(header: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    const key = name.replace(/^﻿/, "").trim().toUpperCase();
    if (key !== "" && !index.has(key)) index.set(key, position);
  });
  return index;
}

function statusOf(value: string): MicStatus {
  const upper = value.trim().toUpperCase();
  if (upper === "ACTIVE" || upper === "UPDATED" || upper === "EXPIRED") return upper;
  return "UNKNOWN";
}

/**
 * Turns the register's CSV into rows the `markets` catalog can take.
 *
 * The transformations are deliberately few, because this is a reference
 * register and not our data:
 * - the MIC and the operating MIC are upper-cased (they are upper-case in the
 *   file; this makes the match against the catalog case-safe either way);
 * - the country code is upper-cased and kept only when it is two letters;
 * - the market name is passed through **as published**, upper-case and all.
 *   Title-casing it would be inventing a spelling for a name that has an
 *   official one.
 *
 * A row with no MIC is dropped: it cannot satisfy the catalog's unique key,
 * so it is not data.
 *
 * @throws {ProviderError} the file did not carry the columns we read.
 */
export function parseMicCsv(text: string): ParsedMic[] {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new ProviderError("bad_response", "The MIC register answered an empty file.");
  }
  const columns = indexHeader(rows[0]);
  const missing = Object.values(HEADERS).filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new ProviderError(
      "bad_response",
      `The MIC register is missing the column(s) ${missing.join(", ")}.`,
    );
  }

  const at = (row: readonly string[], name: string): string => {
    const position = columns.get(name);
    return position === undefined ? "" : toText(row[position]);
  };

  const parsed: ParsedMic[] = [];
  for (const row of rows.slice(1)) {
    // A trailing blank line, or a stray separator row.
    if (row.length === 0 || row.every((field) => field.trim() === "")) continue;
    const mic = at(row, HEADERS.mic).toUpperCase();
    if (mic === "") continue;
    const country = at(row, HEADERS.country).toUpperCase();
    parsed.push({
      mic_code: mic,
      operating_mic: at(row, HEADERS.operatingMic).toUpperCase(),
      market_name: at(row, HEADERS.name),
      iso_country_code: /^[A-Z]{2}$/.test(country) ? country : "",
      city: at(row, HEADERS.city),
      status: statusOf(at(row, HEADERS.status)),
    });
  }
  return parsed;
}

/** Whether a row is loaded, given the integration's `includeExpired` setting. */
export function isLoadableMic(row: ParsedMic, includeExpired: boolean): boolean {
  if (row.status === "ACTIVE" || row.status === "UPDATED") return true;
  // UNKNOWN is a status the register has not used yet; treating it as live
  // would insert rows on a guess, so it is loaded only with the expired ones.
  return includeExpired;
}

/**
 * Downloads and parses the register.
 *
 * @throws {ProviderError} for every failure: unreachable, refused, or a file
 * whose columns are not the ones documented.
 */
export async function fetchMicRegister(baseUrl: string): Promise<ParsedMic[]> {
  const url = `${baseUrl}${MIC_CSV_PATH}`;
  const text = await fetchText(url, { timeoutMs: MIC_TIMEOUT_MS });
  if (text.trim() === "") {
    throw new ProviderError("bad_response", `${redactUrl(url)} answered an empty file.`);
  }
  return parseMicCsv(text);
}
