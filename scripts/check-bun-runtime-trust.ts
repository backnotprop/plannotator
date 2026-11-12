import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

export const MIN_BUN_VERSION = "1.4.4";

export const EMSIGN_ECC_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBrMQswCQYDVQQGEwJJTjETMBEG
A1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEg
MB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMwHhcNMTgwMjE4MTgzMDAwWhcNNDMwMjE4
MTgzMDAwWjBrMQswCQYDVQQGEwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11
ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0g
RzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQjpQy4LRL1KPOxst3iAhKAnjlfSU2fySU0WXTsuwYc
58Byr+iuL+FBVIcUqEqy6HyC5ltqtdyzdc6LBtCGI79G1Y4PPwT01xySfvalY8L1X44uT6EYGQIr
MgqCZH0Wk9GjQjBAMB0GA1UdDgQWBBR8XQKEE9TMipuBzhccLikenEhjQjAOBgNVHQ8BAf8EBAMC
AQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAwNpADBmAjEAvvNhzwIQHWSVB7gYboiFBS+D
CBeQyh+KTOgNG3qxrdWBCUfvO6wIBHxcmbHtRwfSAjEAnbpV/KlK6O3t5nYBQnvI+GDZjVGLVTv7
jHvrZQnD+JbNR6iC8hZVdyR+EhCVBCyj
-----END CERTIFICATE-----
`;

export const BLOCKED_KEY_CHECK_MARKER = "addBlockedSPKIForTesting";

const PEM_BEGIN = Buffer.from("-----BEGIN CERTIFICATE-----");
const PEM_END = Buffer.from("-----END CERTIFICATE-----");
const VERSION_RE = /Bun v(\d+)\.(\d+)\.(\d+) \([0-9a-f]+\)/g;

const g3 = new X509Certificate(EMSIGN_ECC_G3_PEM);
const G3_DER = g3.raw;
const G3_SPKI = g3.publicKey.export({ type: "spki", format: "der" });

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function pemBodyDer(body: Buffer): Buffer | null {
  const cleaned = body.toString("latin1").replace(/\\n|["\s]/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(cleaned)) return null;
  return Buffer.from(cleaned, "base64");
}

function holdsG3Pem(bytes: Buffer): boolean {
  let at = bytes.indexOf(PEM_BEGIN);
  while (at !== -1) {
    const end = bytes.indexOf(PEM_END, at + PEM_BEGIN.length);
    if (end === -1) return false;
    const der = pemBodyDer(bytes.subarray(at + PEM_BEGIN.length, end));
    if (der !== null && der.equals(G3_DER)) return true;
    at = bytes.indexOf(PEM_BEGIN, end + PEM_END.length);
  }
  return false;
}

export function bunRuntimeTrustProblems(bytes: Buffer): string[] {
  const problems: string[] = [];
  const text = bytes.toString("latin1");
  const versions = [...text.matchAll(VERSION_RE)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const min = MIN_BUN_VERSION.split(".").map(Number);
  if (versions.length === 0) {
    problems.push("no embedded Bun version found");
  } else {
    const low = versions.filter((v) => compareVersions(v, min) < 0).map((v) => v.join("."));
    if (low.length > 0) problems.push(`embedded Bun ${[...new Set(low)].join(", ")} is below ${MIN_BUN_VERSION}`);
  }
  if (holdsG3Pem(bytes)) problems.push("embeds emSign ECC Root CA - G3 as PEM");
  if (bytes.includes(G3_DER)) problems.push("embeds emSign ECC Root CA - G3 as DER");
  if (bytes.includes(G3_SPKI)) problems.push("embeds the emSign ECC Root CA - G3 public key");
  if (!text.includes(BLOCKED_KEY_CHECK_MARKER)) problems.push("lacks Bun's blocked-key check (oven-sh/bun#46300)");
  return problems;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun scripts/check-bun-runtime-trust.ts <binary>...");
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const problems = bunRuntimeTrustProblems(readFileSync(file));
    if (problems.length === 0) {
      console.log(`OK   ${file}`);
    } else {
      failed = true;
      for (const problem of problems) console.error(`FAIL ${file}: ${problem}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
