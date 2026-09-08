import { describe, expect, test } from "bun:test";

/**
 * Parity guard for the VENDORED review-args copy (generated/review-args.ts,
 * written by vendor.sh). Pi's /plannotator-review parses through this copy,
 * so a forgotten vendor run would leave Pi on a parser that silently swallows
 * flags the shared parser now reports — the exact cross-host drift the
 * `errors` contract exists to prevent.
 */
describe("vendored review-args parity", () => {
  test("the vendored parser reports unknown dash-prefixed tokens", async () => {
    const { parseReviewArgs } = await import("./generated/review-args.ts");
    const parsed = parseReviewArgs("--bse main");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
  });
});
