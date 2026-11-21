/**
 * Safe updates, step 1 (owner-approved, .product/approved/safe-updates-step1/).
 *
 * Why: the update wrapper used to download install.sh with the system `curl`,
 * and on macOS that curl still trusts the root certificates whose keys leaked
 * in the eMudhra incident, so anyone holding them could serve a different
 * install script or binary. This module is the part the running Plannotator
 * does with its OWN fetch (Bun 1.4.4 blocks those keys) before anything runs:
 *
 *   1. download the install script (https://plannotator.ai/install.sh, or the
 *      PLANNOTATOR_INSTALL_SCRIPT_URL test/mirror knob) and the `.sha256` of
 *      the binary install.sh will pick on this machine (required), plus the
 *      other CPU type's when it can be read (optional);
 *   2. write the script and `expected-sha256` into a private temp dir (0700,
 *      files 0600) and print that dir.
 *
 * The POSIX update wrapper (auto-update.ts) runs it as `plannotator
 * update-prepare <version>`, then runs the saved script with
 * PLANNOTATOR_EXPECTED_SHA256, which install.sh compares its own download
 * against before it replaces anything (exit UPDATE_CHECKSUM_MISMATCH on a
 * mismatch, the old binary kept). Any failure here means nothing runs and nothing changes: exit
 * UPDATE_PREPARE_FAILED, an `update:` line on stderr (update.log), and a
 * later retry. There is never a fallback to downloading the script with curl:
 * anyone holding a leaked key could force that fallback, and macOS curl
 * accepts their chain.
 *
 * A network that inspects HTTPS with its own root (a company proxy) fails
 * Bun's built-in roots. That root is in this computer's store, which curl
 * used, so after a certificate error each download is tried once more with
 * Bun's roots plus this computer's (systemTrustedCa). Bun still refuses the
 * compromised eMudhra keys there (CERT_REVOKED, whatever the roots), so the
 * protection holds.
 *
 * Windows is unchanged: Windows blocks the leaked keys in its own store, which
 * the PowerShell wrapper's Invoke-WebRequest uses.
 */

import { X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { isAllowedOverrideUrl } from "@plannotator/shared/update-check";
import { AUTO_UPDATE_LOCK_STALE_MS, UPDATE_PREPARE_FAILED, installScriptUrl } from "./auto-update";
import { UPDATE_OLD_SCRIPT_NOTE, UPDATE_STAGING_PREFIX, UPDATE_TLS_HINT, type UpdateTlsFailure } from "./update-log";

export { UPDATE_CHECKSUM_MISMATCH, UPDATE_PREPARE_FAILED } from "./auto-update";

export const UPDATE_DIR_PREFIX = "plannotator-update-";
export const UPDATE_PREPARE_TIMEOUT_MS = 30_000;
/** A script larger than this is not ours (install.sh is about 125 KB). */
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
/** Present in every install.sh: a page that lacks it (a proxy's error page) is never run. */
const SCRIPT_MARKER = 'REPO="backnotprop/plannotator"';
const DEFAULT_RELEASE_DOWNLOAD_URL = "https://github.com/backnotprop/plannotator/releases/download";
/** emSign ECC Root CA - G3 (SHA-256). Bun 1.4.4 dropped it; the certificate retry never takes it back from this computer's store. */
const EMSIGN_ECC_G3_SHA256 = "86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B";

export {
  UPDATE_OLD_SCRIPT_NOTE,
  UPDATE_STAGING_PREFIX,
  UPDATE_TLS_HINT,
  lastRunLog,
  lastRunTlsFailure,
  stagingFailureIn,
  tlsFailureIn,
  withoutLogOnlyLines,
  type UpdateTlsFailure,
} from "./update-log";

function errorCode(err: unknown): string | undefined {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The server's certificate was refused (verify codes: no trusted issuer, self-signed, revoked, expired, wrong host). */
export function isCertificateError(err: unknown): boolean {
  if (/CERT|SELF_SIGNED|ISSUER|LEAF_SIGNATURE/.test(errorCode(err) ?? "")) return true;
  return err instanceof Error && /certificate/i.test(err.message);
}

function isRevokedError(err: unknown): boolean {
  return errorCode(err) === "CERT_REVOKED" || (err instanceof Error && /certificate revoked/i.test(err.message));
}

/** A CA file read for the retry is at most this big (a full system bundle is about 220 KB). */
const MAX_CA_FILE_BYTES = 4 * 1024 * 1024;
/** All the files of a `capath` directory together are read up to this. */
const MAX_CA_DIR_BYTES = 16 * 1024 * 1024;
const MAX_CURLRC_BYTES = 64 * 1024;
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The certificates in a PEM file; [] when it is missing, unreadable, not a file, or over `cap`. */
function readPemFile(path: string, cap: number = MAX_CA_FILE_BYTES): string[] {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > cap) return [];
    return readFileSync(path, "utf-8").match(PEM_CERT_RE) ?? [];
  } catch {
    return [];
  }
}

function readPemDir(path: string): string[] {
  const out: string[] = [];
  let budget = MAX_CA_DIR_BYTES;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = join(path, name);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size > budget) break;
    budget -= size;
    out.push(...readPemFile(file));
  }
  return out;
}

/**
 * The `cacert` and `capath` of the .curlrc curl reads ($CURL_HOME, then
 * $XDG_CONFIG_HOME, then $HOME; the first that exists), the last of each.
 * Only absolute paths (a leading `~/` is the home dir).
 */
function curlrcCaPaths(env: NodeJS.ProcessEnv): { cacert?: string; capath?: string } {
  for (const dir of [env.CURL_HOME, env.XDG_CONFIG_HOME, env.HOME]) {
    if (!dir) continue;
    const rc = join(dir, ".curlrc");
    let text: string;
    try {
      const st = statSync(rc);
      if (!st.isFile() || st.size > MAX_CURLRC_BYTES) return {};
      text = readFileSync(rc, "utf-8");
    } catch {
      continue;
    }
    const found: { cacert?: string; capath?: string } = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:--)?(cacert|capath)(?:\s*[=:]\s*|\s+)(.+?)\s*$/.exec(line);
      if (!m) continue;
      let value = m[2]!;
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
      if (value.startsWith("~/") && env.HOME) value = join(env.HOME, value.slice(2));
      if (value.startsWith("/")) found[m[1] as "cacert" | "capath"] = value;
    }
    return found;
  }
  return {};
}

/**
 * The certificates only curl read on main: $CURL_CA_BUNDLE, and `cacert` /
 * `capath` in ~/.curlrc. A machine whose company root lives only there
 * updated through curl before; the retry reads them too.
 */
export function curlCaCertificates(env: NodeJS.ProcessEnv = process.env): string[] {
  const rc = curlrcCaPaths(env);
  const bundle = env.CURL_CA_BUNDLE?.trim();
  return [
    ...(bundle ? readPemFile(bundle) : []),
    ...(rc.cacert ? readPemFile(rc.cacert) : []),
    ...(rc.capath ? readPemDir(rc.capath) : []),
  ];
}

function notG3(pem: string): boolean {
  try {
    return new X509Certificate(pem).fingerprint256 !== EMSIGN_ECC_G3_SHA256;
  } catch {
    return false;
  }
}

/**
 * The roots for the retry after a certificate error: Bun's own (with
 * NODE_EXTRA_CA_CERTS) plus this computer's. On macOS those are the
 * keychains' trusted certificates, where a company's management profile puts
 * its root; on Linux, /etc/ssl/certs, which update-ca-certificates fills.
 * Plus what only curl read (curlCaCertificates). Never emSign ECC Root CA -
 * G3. Null when nothing is added. Read only on that retry, never on the
 * normal path.
 */
export function systemTrustedCa(
  get: ((kind: string) => string[]) | undefined = (tls as { getCACertificates?: (kind: string) => string[] }).getCACertificates,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  let base: string[] = [...tls.rootCertificates];
  let system: string[] = [];
  if (typeof get === "function") {
    try {
      system = get("system");
      base = get("default");
    } catch {}
  }
  const added = [...system, ...curlCaCertificates(env)].filter(notG3);
  return added.length > 0 ? [...base, ...added] : null;
}

/** "0.28.33", "v0.28.33" -> "v0.28.33"; anything else (a pre-release, junk) -> null. */
export function normalizeReleaseTag(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? `v${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** The binaries this OS's install script may download: it picks the CPU type itself. */
export function candidateAssets(platform: NodeJS.Platform): string[] {
  const os = platform === "darwin" ? "darwin" : "linux";
  return [`plannotator-${os}-arm64`, `plannotator-${os}-x64`];
}

/**
 * The binary install.sh will pick on this machine. It reads `uname -m` with
 * no Rosetta detection, and a child of this process sees the same CPU type
 * this process runs as (an x64 build under Rosetta: x86_64), so it is
 * `process.arch`. Null for a CPU type install.sh does not ship.
 */
export function nativeAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (arch !== "arm64" && arch !== "x64") return null;
  return `plannotator-${platform === "darwin" ? "darwin" : "linux"}-${arch}`;
}

/** Where release assets download from: PLANNOTATOR_RELEASE_DOWNLOAD_URL (`https:` or loopback `http:`), else GitHub. */
export function releaseDownloadUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PLANNOTATOR_RELEASE_DOWNLOAD_URL?.trim().replace(/\/+$/, "");
  return raw && isAllowedOverrideUrl(raw) ? raw : DEFAULT_RELEASE_DOWNLOAD_URL;
}

export type PrepareResult =
  /** `notes`: the other CPU type's checksum, when it could not be read (optional; never a failure). */
  | { ok: true; dir: string; expected: string; scriptChecksPin: boolean; notes: string[] }
  /** `staging`: downloaded, but the temp folder could not hold it (full, read-only); `error` says so in plain words. */
  | { ok: false; error: string; tls?: UpdateTlsFailure; staging?: true };

export interface PrepareDeps {
  version: string;
  platform: NodeJS.Platform;
  /** This process's CPU type (default `process.arch`): its checksum is required, the other one's is not. */
  arch?: string;
  env?: NodeJS.ProcessEnv;
  tmpRoot?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The roots for the retry after a certificate error (default systemTrustedCa; null: no retry). */
  systemCa?: () => string[] | null;
  /** How long the other CPU type's checksum may lag once the required downloads are in (default OPTIONAL_CHECKSUM_GRACE_MS). */
  optionalGraceMs?: number;
  /** Bun's certificate lists (tests): default `tls.getCACertificates`. */
  caStore?: (kind: string) => string[];
}

/**
 * The other CPU type's `.sha256` is optional: once install.sh and this
 * machine's `.sha256` are in, it gets this long, then it is skipped (a note),
 * so a stall there never holds up the update.
 */
export const OPTIONAL_CHECKSUM_GRACE_MS = 2_000;

type Fetched = { ok: true; text: string } | { ok: false; error: string; tls?: UpdateTlsFailure };

async function fetchText(
  url: string,
  f: typeof fetch,
  timeoutMs: number,
  systemCa: () => string[] | null,
  stop?: AbortSignal,
): Promise<Fetched> {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  const attempt = async (ca?: string[]): Promise<Fetched> => {
    const res = await f(url, {
      redirect: "follow",
      headers: { "user-agent": "plannotator-update" },
      signal: stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs),
      ...(ca && { tls: { ca } }),
    } as RequestInit);
    // Bun 1.3.14 hands back a refusing proxy's 502 as a response, 1.4.4 throws; both end here.
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${host}` };
    return { ok: true, text: await res.text() };
  };
  const failed = (err: unknown): Fetched => ({
    ok: false,
    error: `${host}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
    ...(isCertificateError(err) && { tls: isRevokedError(err) ? ("revoked" as const) : ("untrusted" as const) }),
  });
  try {
    return await attempt();
  } catch (err) {
    // A revoked chain is refused whatever the roots, and any other error is not about roots.
    if (!isCertificateError(err) || isRevokedError(err)) return failed(err);
    const ca = stop?.aborted ? null : systemCa();
    if (!ca) return failed(err);
    try {
      return await attempt(ca);
    } catch (again) {
      return failed(again);
    }
  }
}

/**
 * Download and stage. Never throws; on any failure nothing is left on disk.
 */
export async function prepareUpdate(deps: PrepareDeps): Promise<PrepareResult> {
  const env = deps.env ?? process.env;
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? UPDATE_PREPARE_TIMEOUT_MS;
  const tag = normalizeReleaseTag(deps.version);
  if (!tag) return { ok: false, error: `not a release version: ${deps.version}` };
  if (deps.platform === "win32") return { ok: false, error: "Windows updates do not use this step" };

  const native = nativeAsset(deps.platform, deps.arch ?? process.arch);
  if (!native) return { ok: false, error: `no Plannotator build for this CPU type (${deps.arch ?? process.arch})` };
  // The native first: it is required. The other CPU type's checksum is only
  // pinned when it can be read, so a release that stops shipping one CPU type
  // never stops updates for the other.
  const assets = [native, ...candidateAssets(deps.platform).filter((a) => a !== native)];
  const base = releaseDownloadUrl(env);
  // Read once, and only when a certificate error asks for it.
  let roots: string[] | null | undefined;
  const systemCa = () => (roots === undefined ? (roots = deps.systemCa ? deps.systemCa() : systemTrustedCa(undefined, env)) : roots);
  const sumUrl = (asset: string) => `${base}/${tag}/${asset}.sha256`;
  const stopOptional = new AbortController();
  const optional = assets.slice(1).map((a) => fetchText(sumUrl(a), f, timeoutMs, systemCa, stopOptional.signal));
  const [script, nativeSum] = await Promise.all([
    fetchText(installScriptUrl(deps.platform, env), f, timeoutMs, systemCa),
    fetchText(sumUrl(native), f, timeoutMs, systemCa),
  ]);
  // The required downloads are in (or failed): the optional checksum gets a
  // short grace, then is skipped, so it never holds up the update.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceOver = new Promise<void>((done) => {
    graceTimer = setTimeout(done, script.ok && nativeSum.ok ? (deps.optionalGraceMs ?? OPTIONAL_CHECKSUM_GRACE_MS) : 0);
  });
  await Promise.race([Promise.all(optional), graceOver]);
  clearTimeout(graceTimer);
  stopOptional.abort();
  const late = (r: Fetched): Fetched =>
    !r.ok && stopOptional.signal.aborted && /abort/i.test(r.error) ? { ok: false, error: "no answer in time" } : r;
  const sums = [nativeSum, ...(await Promise.all(optional)).map(late)];
  if (!script!.ok) return { ok: false, error: `install script: ${script!.error}`, ...(script!.tls && { tls: script!.tls }) };
  const body = script!.text;
  if (!body.startsWith("#!") || !body.includes(SCRIPT_MARKER) || body.length > MAX_SCRIPT_BYTES) {
    return { ok: false, error: "install script: the download is not Plannotator's install script" };
  }
  const pairs: string[] = [];
  const notes: string[] = [];
  for (let i = 0; i < assets.length; i++) {
    const r = sums[i]!;
    const m = r.ok ? /^([0-9a-fA-F]{64})(?:\s|$)/.exec(r.text) : null;
    if (m) {
      pairs.push(`${assets[i]}=${m[1]!.toLowerCase()}`);
      continue;
    }
    const reason = `${assets[i]}.sha256: ${r.ok ? "not a SHA-256 checksum" : r.error}`;
    if (assets[i] === native) return { ok: false, error: reason, ...(!r.ok && r.tls && { tls: r.tls }) };
    notes.push(`${reason} (not this machine's CPU type; skipped)`);
  }

  // Absolute even under a relative TMPDIR: the wrapper only uses an absolute dir.
  const root = resolve(deps.tmpRoot ?? tmpdir());
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(root, UPDATE_DIR_PREFIX));
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "install.sh"), body, { mode: 0o600 });
    writeFileSync(join(dir, "expected-sha256"), pairs.join(" "), { mode: 0o600 });
    const bundle = curlBundleWithExtraCa(env, deps.caStore);
    if (bundle) writeFileSync(join(dir, CURL_BUNDLE_FILE), bundle, { mode: 0o600 });
    return { ok: true, dir, expected: pairs.join(" "), scriptChecksPin: body.includes("PLANNOTATOR_EXPECTED_SHA256"), notes };
  } catch (err) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return { ok: false, staging: true, error: stagingReason(err, root) };
  }
}

/** Plain words for a temp folder the update could not be saved in. */
function stagingReason(err: unknown, root: string): string {
  const code = errorCode(err);
  if (code === "ENOSPC" || code === "EDQUOT") return `the temp folder ${root} is full (${code})`;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return `the temp folder ${root} can't be written (${code})`;
  if (code === "ENOENT" || code === "ENOTDIR") return `the temp folder ${root} does not exist (${code})`;
  return `could not write to the temp folder ${root} (${(err instanceof Error ? err.message : String(err)).slice(0, 120)})`;
}

/**
 * The file in the staged dir the wrapper passes to install.sh as
 * CURL_CA_BUNDLE (auto-update.ts), so install.sh's curl trusts what
 * Plannotator's fetch trusted when the person followed the
 * NODE_EXTRA_CA_CERTS hint.
 */
export const CURL_BUNDLE_FILE = "curl-ca-bundle.pem";

/** curl's default bundle, by distro (the first that exists); macOS curl's LibreSSL file last. */
const CURL_DEFAULT_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/**
 * Only when NODE_EXTRA_CA_CERTS names a readable certificate: a bundle of
 * every root install.sh's curl trusted before (its default bundle, plus what
 * it reads from $SSL_CERT_FILE, $CURL_CA_BUNDLE and ~/.curlrc), Bun's roots,
 * this computer's, and that certificate. Never emSign ECC Root CA - G3. A
 * bundle replaces curl's own roots, so it only ever adds to them (and drops
 * G3). Null otherwise: then the wrapper leaves curl exactly as it was.
 */
export function curlBundleWithExtraCa(
  env: NodeJS.ProcessEnv,
  get: ((kind: string) => string[]) | undefined = (tls as { getCACertificates?: (kind: string) => string[] }).getCACertificates,
): string | null {
  const extraPath = env.NODE_EXTRA_CA_CERTS?.trim();
  if (!extraPath) return null;
  const extra = readPemFile(extraPath).filter(notG3);
  if (extra.length === 0) return null;
  const sslCertFile = env.SSL_CERT_FILE?.trim();
  const curlDefault = CURL_DEFAULT_BUNDLES.map((p) => readPemFile(p)).find((certs) => certs.length > 0) ?? [];
  let bun: string[] = [...tls.rootCertificates];
  let system: string[] = [];
  if (typeof get === "function") {
    try {
      bun = get("bundled");
      system = get("system");
    } catch {}
  }
  const all = [...curlDefault, ...(sslCertFile ? readPemFile(sslCertFile) : []), ...bun, ...system, ...curlCaCertificates(env), ...extra]
    .map((pem) => pem.trim())
    .filter(notG3);
  return `${[...new Set(all)].join("\n")}\n`;
}

/**
 * The dirs a wrapper killed outright (SIGKILL, a power cut) left behind:
 * removed at the start of the next update once older than the lock's own
 * stale age, so a live run's dir is never touched.
 */
export function sweepStaleUpdateDirs(tmpRoot: string = tmpdir(), now: number = Date.now(), maxAgeMs: number = AUTO_UPDATE_LOCK_STALE_MS): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(UPDATE_DIR_PREFIX)) continue;
    const path = join(tmpRoot, name);
    try {
      if (now - statSync(path).mtimeMs >= maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

export interface UpdatePrepareCommandDeps extends Omit<PrepareDeps, "version"> {
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => number;
}

/**
 * `plannotator update-prepare <version>` (internal; the POSIX update wrapper
 * runs it). Prints the staged dir on stdout, and nothing else; reasons go to
 * stderr. Exit 0, or UPDATE_PREPARE_FAILED.
 */
export async function runUpdatePrepareCommand(args: string[], deps: UpdatePrepareCommandDeps): Promise<number> {
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const err = deps.err ?? ((t: string) => process.stderr.write(t));
  const version = args[0];
  if (!version || args.length !== 1) {
    err("update: usage: plannotator update-prepare <version>\n");
    return UPDATE_PREPARE_FAILED;
  }
  sweepStaleUpdateDirs(resolve(deps.tmpRoot ?? tmpdir()), (deps.now ?? Date.now)());
  const result = await prepareUpdate({ ...deps, version });
  if (!result.ok) {
    if (result.staging) {
      err(`${UPDATE_STAGING_PREFIX}${result.error}; nothing was changed\n`);
      return UPDATE_PREPARE_FAILED;
    }
    err(`update: could not download the update (${result.error}); nothing was changed\n`);
    if (result.tls) err(`${UPDATE_TLS_HINT[result.tls]}\n`);
    return UPDATE_PREPARE_FAILED;
  }
  for (const note of result.notes) err(`update: ${note}\n`);
  if (!result.scriptChecksPin) err(`${UPDATE_OLD_SCRIPT_NOTE}\n`);
  out(`${result.dir}\n`);
  return 0;
}

