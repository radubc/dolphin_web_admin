/**
 * Unit tests for the pure half of `./recovery-codes` — generation, display,
 * normalisation, hashing, and which Prisma errors count as a schema fault.
 * The database half is exercised on stage (`docs/two-factor-plan.md`, phase
 * B stage test).
 *
 *     npm test
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type * as PrismaAdminClient from "@/generated/prisma-admin/client";
import type * as RecoveryCodes from "./recovery-codes";

const {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  formatRecoveryCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  isMissingTableError,
  isSchemaFaultError,
  normaliseRecoveryCode,
} = (await import("./recovery-codes" + ".ts")) as typeof RecoveryCodes;
const { Prisma } = (await import("@/generated/prisma-admin/client" + ".ts")) as typeof PrismaAdminClient;

describe("the alphabet", () => {
  it("has 31 symbols and none of the look-alikes", () => {
    assert.equal(RECOVERY_CODE_ALPHABET.length, 31);
    assert.equal(new Set(RECOVERY_CODE_ALPHABET).size, 31);
    for (const banned of "0o1il") {
      assert.ok(!RECOVERY_CODE_ALPHABET.includes(banned), `contains ${banned}`);
    }
    assert.equal(RECOVERY_CODE_ALPHABET, RECOVERY_CODE_ALPHABET.toLowerCase());
  });
});

describe("generateRecoveryCode", () => {
  it("is ten symbols from the alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateRecoveryCode();
      assert.equal(code.length, RECOVERY_CODE_LENGTH);
      for (const symbol of code) {
        assert.ok(RECOVERY_CODE_ALPHABET.includes(symbol), `${symbol} not in alphabet`);
      }
    }
  });

  it("uses every symbol (rejection sampling does not starve the tail)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500 && seen.size < 31; i += 1) {
      for (const symbol of generateRecoveryCode()) seen.add(symbol);
    }
    assert.equal(seen.size, 31);
  });
});

describe("generateRecoveryCodes", () => {
  it("makes ten distinct codes by default", () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, RECOVERY_CODE_COUNT);
    assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
  });
});

describe("formatRecoveryCode", () => {
  it("puts one dash after the fifth symbol", () => {
    assert.equal(formatRecoveryCode("abcdefghjk"), "abcde-fghjk");
  });
});

describe("normaliseRecoveryCode", () => {
  it("lowercases and drops the dash, spaces and a pasted bullet", () => {
    assert.equal(normaliseRecoveryCode("ABCDE-FGHJK"), "abcdefghjk");
    assert.equal(normaliseRecoveryCode("  abcde fghjk "), "abcdefghjk");
    assert.equal(normaliseRecoveryCode("• abcde-fghjk"), "abcdefghjk");
  });

  it("refuses anything that is not exactly ten symbols afterwards", () => {
    assert.equal(normaliseRecoveryCode(""), null);
    assert.equal(normaliseRecoveryCode("abcde-fghj"), null);
    assert.equal(normaliseRecoveryCode("abcde-fghjkm"), null);
    // `O` and `l` are not in the alphabet: dropped, so the code comes up short.
    assert.equal(normaliseRecoveryCode("abcdO-fghjk"), null);
    assert.equal(normaliseRecoveryCode("abcdl-fghjk"), null);
  });

  it("round-trips a generated code through its display form", () => {
    for (const code of generateRecoveryCodes()) {
      assert.equal(normaliseRecoveryCode(formatRecoveryCode(code)), code);
      assert.equal(normaliseRecoveryCode(formatRecoveryCode(code).toUpperCase()), code);
    }
  });
});

describe("hashRecoveryCode", () => {
  it("is SHA-256 of the normalised code, lowercase hex", () => {
    const expected = createHash("sha256").update("abcdefghjk").digest("hex");
    assert.equal(hashRecoveryCode("abcdefghjk"), expected);
    assert.match(hashRecoveryCode("abcdefghjk"), /^[0-9a-f]{64}$/);
  });
});

describe("isSchemaFaultError", () => {
  function prismaError(code: string, meta?: Record<string, unknown>): Error {
    return new Prisma.PrismaClientKnownRequestError("database said no", {
      code,
      clientVersion: "test",
      meta,
    });
  }

  it("matches a missing table from a typed query (P2021)", () => {
    assert.equal(isSchemaFaultError(prismaError("P2021")), true);
  });

  it("matches a missing table from a raw query (P2010 / 42P01)", () => {
    assert.equal(isSchemaFaultError(prismaError("P2010", { code: "42P01" })), true);
  });

  it("matches permission denied from a raw query (P2010 / 42501): the table belongs to another role", () => {
    assert.equal(isSchemaFaultError(prismaError("P2010", { code: "42501" })), true);
  });

  it("matches nothing else", () => {
    assert.equal(isSchemaFaultError(prismaError("P2010", { code: "23505" })), false);
    assert.equal(isSchemaFaultError(prismaError("P2010")), false);
    assert.equal(isSchemaFaultError(prismaError("P2010", { code: 42501 })), false);
    assert.equal(isSchemaFaultError(prismaError("P2002", { code: "42501" })), false);
    assert.equal(isSchemaFaultError(prismaError("P2025")), false);
    assert.equal(isSchemaFaultError(new Error("permission denied for table admin_user_recovery_codes")), false);
    assert.equal(isSchemaFaultError({ code: "P2021" }), false);
    assert.equal(isSchemaFaultError(null), false);
    assert.equal(isSchemaFaultError(undefined), false);
  });

  it("keeps its earlier name as an alias", () => {
    assert.equal(isMissingTableError, isSchemaFaultError);
  });
});
