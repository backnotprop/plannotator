/**
 * The release gate in scripts/check-bun-runtime-trust.ts. What regresses if
 * this fails: a release binary built on a Bun that still trusts emSign ECC
 * Root CA - G3 (or lacks the blocked-key check) passes the gate and ships.
 * Synthetic bytes stand in for binaries; the gate reads bytes, not runtimes.
 */
import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { BLOCKED_KEY_CHECK_MARKER, EMSIGN_ECC_G3_PEM, bunRuntimeTrustProblems } from "./check-bun-runtime-trust.ts";

const filler = Buffer.alloc(4096, 0x90);
const fixed = (version = "1.4.4") => Buffer.from(`\0Bun v${version} (38afee6c8)\0${BLOCKED_KEY_CHECK_MARKER}\0`, "latin1");
const binary = (...parts: Buffer[]) => Buffer.concat([filler, ...parts, filler]);
const g3 = new X509Certificate(EMSIGN_ECC_G3_PEM);

/** The PEM as Bun 1.3 embeds roots: 64-column lines. */
function pem64(): Buffer {
  const b64 = g3.raw.toString("base64").match(/.{1,64}/g)!.join("\n");
  return Buffer.from(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, "latin1");
}

describe("Bun runtime trust gate", () => {
  test("a 1.4.4 runtime with the blocked-key check and no G3 passes", () => {
    expect(bunRuntimeTrustProblems(binary(fixed()))).toEqual([]);
    expect(bunRuntimeTrustProblems(binary(fixed("1.5.0")))).toEqual([]);
  });

  test("an older Bun fails, and so does a binary with no Bun version at all", () => {
    expect(bunRuntimeTrustProblems(binary(fixed("1.3.14")))).toEqual(["embedded Bun 1.3.14 is below 1.4.4"]);
    expect(bunRuntimeTrustProblems(binary(fixed("1.4.3")))).toEqual(["embedded Bun 1.4.3 is below 1.4.4"]);
    expect(bunRuntimeTrustProblems(binary(Buffer.from(BLOCKED_KEY_CHECK_MARKER)))).toEqual(["no embedded Bun version found"]);
  });

  test("emSign ECC Root CA - G3 fails the gate as PEM, as DER, or as its public key", () => {
    expect(bunRuntimeTrustProblems(binary(fixed(), pem64()))).toContain("embeds emSign ECC Root CA - G3 as PEM");
    expect(bunRuntimeTrustProblems(binary(fixed(), Buffer.from(EMSIGN_ECC_G3_PEM)))).toContain("embeds emSign ECC Root CA - G3 as PEM");
    expect(bunRuntimeTrustProblems(binary(fixed(), g3.raw))).toContain("embeds emSign ECC Root CA - G3 as DER");
    const spki = g3.publicKey.export({ type: "spki", format: "der" });
    expect(bunRuntimeTrustProblems(binary(fixed(), spki))).toEqual(["embeds the emSign ECC Root CA - G3 public key"]);
  });

  test("another root's PEM is not mistaken for G3", () => {
    const other = Buffer.from("-----BEGIN CERTIFICATE-----\nTUlJQ1RqQ0NBZE9nQXdJQkFnSUtQUFlIcVdod0R0cUxoREFL\n-----END CERTIFICATE-----\n");
    expect(bunRuntimeTrustProblems(binary(fixed(), other))).toEqual([]);
  });

  test("a runtime without the blocked-key check fails", () => {
    expect(bunRuntimeTrustProblems(binary(Buffer.from("Bun v1.4.4 (38afee6c8)")))).toEqual([
      "lacks Bun's blocked-key check (oven-sh/bun#46300)",
    ]);
  });
});
