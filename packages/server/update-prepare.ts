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
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const SCRIPT_MARKER = 'REPO="backnotprop/plannotator"';
const DEFAULT_RELEASE_DOWNLOAD_URL = "https://github.com/backnotprop/plannotator/releases/download";
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

export function isCertificateError(err: unknown): boolean {
  if (/CERT|SELF_SIGNED|ISSUER|LEAF_SIGNATURE/.test(errorCode(err) ?? "")) return true;
  return err instanceof Error && /certificate/i.test(err.message);
}

function isRevokedError(err: unknown): boolean {
  return errorCode(err) === "CERT_REVOKED" || (err instanceof Error && /certificate revoked/i.test(err.message));
}

const MAX_CA_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CA_DIR_BYTES = 16 * 1024 * 1024;
const MAX_CURLRC_BYTES = 64 * 1024;
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

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

export function normalizeReleaseTag(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? `v${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

export function candidateAssets(platform: NodeJS.Platform): string[] {
  const os = platform === "darwin" ? "darwin" : "linux";
  return [`plannotator-${os}-arm64`, `plannotator-${os}-x64`];
}

export function nativeAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (arch !== "arm64" && arch !== "x64") return null;
  return `plannotator-${platform === "darwin" ? "darwin" : "linux"}-${arch}`;
}

export function releaseDownloadUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PLANNOTATOR_RELEASE_DOWNLOAD_URL?.trim().replace(/\/+$/, "");
  return raw && isAllowedOverrideUrl(raw) ? raw : DEFAULT_RELEASE_DOWNLOAD_URL;
}

export type PrepareResult =
  | { ok: true; dir: string; expected: string; scriptChecksPin: boolean; notes: string[] }
  | { ok: false; error: string; tls?: UpdateTlsFailure; staging?: true };

export interface PrepareDeps {
  version: string;
  platform: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  tmpRoot?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  systemCa?: () => string[] | null;
  optionalGraceMs?: number;
  caStore?: (kind: string) => string[];
}

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

export async function prepareUpdate(deps: PrepareDeps): Promise<PrepareResult> {
  const env = deps.env ?? process.env;
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? UPDATE_PREPARE_TIMEOUT_MS;
  const tag = normalizeReleaseTag(deps.version);
  if (!tag) return { ok: false, error: `not a release version: ${deps.version}` };
  if (deps.platform === "win32") return { ok: false, error: "Windows updates do not use this step" };

  const native = nativeAsset(deps.platform, deps.arch ?? process.arch);
  if (!native) return { ok: false, error: `no Plannotator build for this CPU type (${deps.arch ?? process.arch})` };
  const assets = [native, ...candidateAssets(deps.platform).filter((a) => a !== native)];
  const base = releaseDownloadUrl(env);
  let roots: string[] | null | undefined;
  const systemCa = () => (roots === undefined ? (roots = deps.systemCa ? deps.systemCa() : systemTrustedCa(undefined, env)) : roots);
  const sumUrl = (asset: string) => `${base}/${tag}/${asset}.sha256`;
  const stopOptional = new AbortController();
  const optional = assets.slice(1).map((a) => fetchText(sumUrl(a), f, timeoutMs, systemCa, stopOptional.signal));
  const [script, nativeSum] = await Promise.all([
    fetchText(installScriptUrl(deps.platform, env), f, timeoutMs, systemCa),
    fetchText(sumUrl(native), f, timeoutMs, systemCa),
  ]);
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

function stagingReason(err: unknown, root: string): string {
  const code = errorCode(err);
  if (code === "ENOSPC" || code === "EDQUOT") return `the temp folder ${root} is full (${code})`;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return `the temp folder ${root} can't be written (${code})`;
  if (code === "ENOENT" || code === "ENOTDIR") return `the temp folder ${root} does not exist (${code})`;
  return `could not write to the temp folder ${root} (${(err instanceof Error ? err.message : String(err)).slice(0, 120)})`;
}

export const CURL_BUNDLE_FILE = "curl-ca-bundle.pem";

const CURL_DEFAULT_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

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

