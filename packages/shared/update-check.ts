/**
 * The one "is there a newer Plannotator?" check, shared by everything that
 * shows an update notice (the Inbox, the plan / annotate / review servers of
 * the compiled CLI and of Pi, `plannotator update`, the terminal hint) and by
 * background auto-update (packages/server/auto-update.ts).
 *
 * The machine asks GitHub: at most once per 24h per data
 * dir, and after a failed check (offline, 403/429, a proxy) no sooner than 6h.
 * The answer is cached in `update-state.json` beside auto-update's own state,
 * and the release notes in `update-notes/<version>.json`, so a check made by
 * one process reaches every other one without a second request.
 *
 * Nothing here throws to a caller: a failure is a line in `update.log`. The
 * scheduled check is never awaited on a session's hot path.
 *
 * Off switch: PLANNOTATOR_UPDATE_CHECK=0 or `{ "updateCheck": false }`
 * (resolveUpdateCheck in config.ts). Off means no automatic request at all;
 * an explicit action (`plannotator update`, the Inbox's Check now) still asks.
 *
 * Node-only (node:fs + global fetch), vendored to Pi.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "./data-dir";

export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed check: try again no sooner than this, never in a loop. */
export const RELEASE_CHECK_RETRY_MS = 6 * 60 * 60 * 1000;
/** "Remind me tomorrow" in the Inbox. */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;
/** The terminal hint shows at most this often. */
export const UPDATE_HINT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Release notes kept per version (the "What's New in" section onward). */
export const RELEASE_NOTES_MAX_BYTES = 64 * 1024;

const REPO = "backnotprop/plannotator";
export const DEFAULT_RELEASE_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const INSTALL_SH_URL = "https://plannotator.ai/install.sh";
export const INSTALL_PS1_URL = "https://plannotator.ai/install.ps1";
export const PI_UPDATE_COMMAND = "pi update --extensions";
export const CLAUDE_PLUGIN_UPDATE_COMMANDS = [
  "claude plugin marketplace update plannotator",
  "claude plugin update plannotator@plannotator",
] as const;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Parse a stable `X.Y.Z` / `vX.Y.Z`; anything else (pre-release, junk) is null. */
export function parseStableVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1; null when either side is not a stable version. */
export function compareStableVersions(a: string, b: string): number | null {
  const pa = parseStableVersion(a);
  const pb = parseStableVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** True only for a strictly newer stable release: never a downgrade or re-install. */
export function isNewerStableVersion(latest: string, current: string): boolean {
  return compareStableVersions(latest, current) === 1;
}

/** The canonical `X.Y.Z` for a stable version string, or null. */
export function normalizeStableVersion(value: unknown): string | null {
  const parsed = parseStableVersion(value);
  return parsed ? parsed.join(".") : null;
}

export function releaseUrlFor(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version.replace(/^v/, "")}`;
}

// ---------------------------------------------------------------------------
// State (update-state.json, shared with auto-update)
// ---------------------------------------------------------------------------

export interface UpdateState {
  /** Auto-update's install window (epoch ms of the last check that got past its gates). */
  lastCheckAt?: number;
  /** The last answer GitHub gave for the latest stable release. */
  latestRelease?: {
    tag: string;
    fetchedAt: number;
    /** The release's `published_at`, when GitHub sent one. */
    publishedAt?: string;
  };
  /** The last attempt to ask GitHub: claimed before the request, so concurrent starts ask once. */
  releaseCheck?: {
    attemptedAt: number;
    /** Set when that attempt failed; the next one waits RELEASE_CHECK_RETRY_MS. */
    failedAt?: number;
    error?: string;
  };
  /** The install this process (or an earlier one) started. */
  pending?: {
    version: string;
    fromVersion: string;
    startedAt: number;
    /** `person`: Update now / `plannotator update`; absent: background auto-update. */
    by?: "person";
  };
  /** The Inbox's "Remind me tomorrow", shared by every Inbox tab. */
  snooze?: { version: string; until: number };
  /** When the terminal hint last printed. */
  hintShownAt?: number;
  /** The version the Inbox last ran, to tell "just updated" on its first start after. */
  inboxVersion?: string;
}

export function updateCheckPaths(dataDir: string = getPlannotatorDataDir()) {
  return {
    state: join(dataDir, "update-state.json"),
    notes: join(dataDir, "update-notes"),
    log: join(dataDir, "update.log"),
  };
}

export function readUpdateState(dataDir?: string): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(updateCheckPaths(dataDir).state, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as UpdateState) : {};
  } catch {
    return {};
  }
}

/** Atomic write (temp + rename). */
export function writeUpdateState(state: UpdateState, dataDir?: string): void {
  const { state: path } = updateCheckPaths(dataDir);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** Read, change, write: the change sees the file as it is now, not as a caller read it earlier. */
export function patchUpdateState(change: (state: UpdateState) => UpdateState, dataDir?: string): UpdateState {
  const next = change(readUpdateState(dataDir));
  writeUpdateState(next, dataDir);
  return next;
}

export function updateLog(message: string, dataDir?: string, tag = "update-check"): void {
  try {
    const { log: path } = updateCheckPaths(dataDir);
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${tag}: ${message}\n`);
  } catch {
    // Best-effort: a check must never surface an error.
  }
}

/** The cached latest-release version when it is still fresh (24h), else null. */
export function cachedLatestTag(state: UpdateState, now: number): string | null {
  const cached = state.latestRelease;
  if (!cached || typeof cached !== "object") return null;
  const at = cached.fetchedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now) return null;
  if (now - at >= RELEASE_CHECK_INTERVAL_MS) return null;
  return normalizeStableVersion(cached.tag);
}

/** The last known latest release, however old: a failed check leaves the last known state in place. */
export function knownLatestRelease(state: UpdateState): { version: string; fetchedAt: number; publishedAt?: string } | null {
  const cached = state.latestRelease;
  if (!cached || typeof cached !== "object") return null;
  const version = normalizeStableVersion(cached.tag);
  if (!version || typeof cached.fetchedAt !== "number") return null;
  return {
    version,
    fetchedAt: cached.fetchedAt,
    ...(typeof cached.publishedAt === "string" && { publishedAt: cached.publishedAt }),
  };
}

/**
 * Whether it is time to ask GitHub: never while the cached answer is under
 * 24h old, and never within 6h of the last attempt (a failure, or another
 * process's request still in flight).
 */
export function isReleaseCheckDue(state: UpdateState, now: number): boolean {
  if (cachedLatestTag(state, now)) return false;
  const attempt = state.releaseCheck?.attemptedAt;
  // A clock that moved backwards must not freeze checks until it catches up.
  if (typeof attempt === "number" && Number.isFinite(attempt) && attempt <= now && now - attempt < RELEASE_CHECK_RETRY_MS) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

export interface ReleaseHighlight {
  version: string;
  text: string;
}

export interface ReleaseNotes {
  version: string;
  publishedAt?: string;
  /** Markdown: the release body from "## What's New in" up to "## Install / Update", capped. */
  notes: string;
  /** The release body's "Missed recent releases?" table, newest first. */
  highlights: ReleaseHighlight[];
}

/** Cut a byte cap on a code point boundary. */
function capUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, "");
}

/** The part of a release body a person reads as "what's new". */
export function extractReleaseNotes(body: unknown): { notes: string; highlights: ReleaseHighlight[] } {
  if (typeof body !== "string") return { notes: "", highlights: [] };
  const text = body.replace(/\r\n/g, "\n");
  const highlights: ReleaseHighlight[] = [];
  for (const m of text.matchAll(/^\|\s*\[v?(\d+\.\d+\.\d+)\]\([^)]*\)\s*\|\s*(.+?)\s*\|\s*$/gm)) {
    const version = normalizeStableVersion(m[1]);
    if (version && highlights.length < 50) highlights.push({ version, text: m[2]!.slice(0, 500) });
  }
  const start = text.search(/^## What's New in\b/m);
  let notes = start >= 0 ? text.slice(start) : "";
  if (notes) {
    // Drop the heading itself (the page carries its own) and the generic install block.
    notes = notes.replace(/^## What's New in[^\n]*\n+/, "");
    const end = notes.search(/^## Install \/ Update\b/m);
    if (end >= 0) notes = notes.slice(0, end);
  }
  return { notes: capUtf8(notes.trim(), RELEASE_NOTES_MAX_BYTES), highlights };
}

function notesPath(version: string, dataDir?: string): string | null {
  const v = normalizeStableVersion(version);
  return v ? join(updateCheckPaths(dataDir).notes, `${v}.json`) : null;
}

export function writeReleaseNotes(notes: ReleaseNotes, dataDir?: string): void {
  const path = notesPath(notes.version, dataDir);
  if (!path) return;
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes) + "\n", "utf-8");
  renameSync(tmp, path);
}

export function readReleaseNotes(version: string, dataDir?: string): ReleaseNotes | null {
  const path = notesPath(version, dataDir);
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReleaseNotes>;
    if (!raw || typeof raw.notes !== "string" || normalizeStableVersion(raw.version) === null) return null;
    return {
      version: normalizeStableVersion(raw.version)!,
      ...(typeof raw.publishedAt === "string" && { publishedAt: raw.publishedAt }),
      notes: capUtf8(raw.notes, RELEASE_NOTES_MAX_BYTES),
      highlights: Array.isArray(raw.highlights)
        ? raw.highlights.filter(
            (h): h is ReleaseHighlight => !!h && typeof h.version === "string" && typeof h.text === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
}

/** The first paragraph of the notes, as plain-ish text, for a dialog's summary. */
export function releaseSummary(notes: string): string {
  for (const para of notes.split(/\n{2,}/)) {
    const t = para.trim();
    if (!t || /^(#|[-*]\s|\||```|<)/.test(t)) continue;
    return t.replace(/\s+/g, " ").slice(0, 600);
  }
  return "";
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface FetchedRelease {
  tag: string;
  publishedAt?: string;
  body?: string;
}

export type FetchReleaseResult = { ok: true; release: FetchedRelease } | { ok: false; error: string };

/**
 * The API URL: PLANNOTATOR_UPDATE_API_URL, a testing / proxy knob like
 * PLANNOTATOR_BITBUCKET_API_URL. Only `https:` or loopback `http:` counts;
 * anything else is ignored.
 */
export function releaseApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PLANNOTATOR_UPDATE_API_URL?.trim();
  return raw && isAllowedOverrideUrl(raw) ? raw : DEFAULT_RELEASE_API_URL;
}

/** `https:`, or `http:` on a loopback host. */
export function isAllowedOverrideUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * One unauthenticated GET. GitHub receives the IP address and this user
 * agent; the version is deliberately not in it.
 */
export async function fetchLatestRelease(
  url: string = releaseApiUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<FetchReleaseResult> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "plannotator-update-check" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; body?: unknown };
    if (body.draft === true || body.prerelease === true) return { ok: false, error: "the latest release is not a stable release" };
    if (typeof body.tag_name !== "string") return { ok: false, error: "no tag_name in the answer" };
    return {
      ok: true,
      release: {
        tag: body.tag_name,
        ...(typeof body.published_at === "string" && { publishedAt: body.published_at }),
        ...(typeof body.body === "string" && { body: body.body }),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ReleaseCheckDeps {
  dataDir?: string;
  now?: () => number;
  /** The knob (resolveUpdateCheck). Ignored when `force` is set. */
  enabled: () => boolean;
  /** An explicit action (`plannotator update`, Check now): ask now, whatever the throttle or the knob say. */
  force?: boolean;
  fetchRelease?: () => Promise<FetchReleaseResult>;
}

export type ReleaseCheckOutcome =
  | { outcome: "disabled" }
  | { outcome: "fresh"; version: string | null }
  | { outcome: "checked"; version: string }
  | { outcome: "failed"; error: string };

/** Ask GitHub when it is time (or when forced) and cache the answer. Never throws. */
export async function runReleaseCheck(deps: ReleaseCheckDeps): Promise<ReleaseCheckOutcome> {
  const dataDir = deps.dataDir;
  const now = (deps.now ?? Date.now)();
  if (!deps.force && !deps.enabled()) return { outcome: "disabled" };
  let state: UpdateState;
  try {
    state = readUpdateState(dataDir);
    if (!deps.force && !isReleaseCheckDue(state, now)) {
      return { outcome: "fresh", version: knownLatestRelease(state)?.version ?? null };
    }
    // Claim the attempt before the network call so concurrent starts ask once.
    state = patchUpdateState((s) => ({ ...s, releaseCheck: { attemptedAt: now } }), dataDir);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateLog(`could not write update-state.json: ${error}`, dataDir);
    return { outcome: "failed", error };
  }
  const result = await (deps.fetchRelease ?? (() => fetchLatestRelease()))();
  // The tag is untrusted input (auto-update passes it to an installer), so it
  // is reduced to a canonical X.Y.Z before anything stores it.
  const version = result.ok ? normalizeStableVersion(result.release.tag) : null;
  if (!result.ok || !version) {
    const error = result.ok ? `not a stable version: ${JSON.stringify(result.release.tag).slice(0, 80)}` : result.error;
    updateLog(`could not read the latest release (${error}); next try in 6h`, dataDir);
    try {
      patchUpdateState((s) => ({ ...s, releaseCheck: { attemptedAt: now, failedAt: now, error: error.slice(0, 200) } }), dataDir);
    } catch {}
    return { outcome: "failed", error };
  }
  const release = result.release;
  try {
    const { notes, highlights } = extractReleaseNotes(release.body);
    writeReleaseNotes({ version, ...(release.publishedAt && { publishedAt: release.publishedAt }), notes, highlights }, dataDir);
  } catch (err) {
    updateLog(`could not save the release notes: ${err instanceof Error ? err.message : String(err)}`, dataDir);
  }
  try {
    patchUpdateState(
      (s) => ({
        ...s,
        latestRelease: { tag: version, fetchedAt: now, ...(release.publishedAt && { publishedAt: release.publishedAt }) },
        releaseCheck: { attemptedAt: now },
        // A newer version clears an older snooze.
        ...(s.snooze && s.snooze.version !== version ? { snooze: undefined } : {}),
      }),
      dataDir,
    );
  } catch {}
  return { outcome: "checked", version };
}

/**
 * Fire-and-forget: returns at once, runs on a later unref'd tick, and logs
 * every failure. For hot paths (a session start, the Inbox's health tick).
 */
export function scheduleReleaseCheck(deps: ReleaseCheckDeps, then?: (outcome: ReleaseCheckOutcome) => void): void {
  const timer = setTimeout(() => {
    runReleaseCheck(deps)
      .then((outcome) => then?.(outcome))
      .catch((err) => updateLog(`check failed: ${err instanceof Error ? err.message : String(err)}`, deps.dataDir));
  }, 0);
  (timer as { unref?: () => void }).unref?.();
}

// ---------------------------------------------------------------------------
// Remembered install flags (install-flags.json, written by the installers)
// ---------------------------------------------------------------------------

/**
 * The install-affecting command-line flags the installers remember in
 * `install-flags.json` (written by install.sh / install.ps1 / install.cmd after
 * a successful run), as neutral ids with their spelling per installer. This is
 * the strict allowlist: anything else in the file is dropped.
 */
export const INSTALL_FLAG_SPELLINGS = {
  minimal: { posix: "--minimal", powershell: "-Minimal" },
  "no-minimal": { posix: "--no-minimal", powershell: "-NoMinimal" },
  "verify-attestation": { posix: "--verify-attestation", powershell: "-VerifyAttestation" },
  "skip-attestation": { posix: "--skip-attestation", powershell: "-SkipAttestation" },
  "with-call-flow": { posix: "--with-call-flow", powershell: "-WithCallFlow" },
  "with-t3": { posix: "--with-t3", powershell: null },
  "without-t3": { posix: "--without-t3", powershell: null },
  "skip-codex": { posix: "--skip-codex", powershell: "-SkipCodex" },
  "skip-gemini": { posix: "--skip-gemini", powershell: "-SkipGemini" },
  "skip-kiro": { posix: "--skip-kiro", powershell: "-SkipKiro" },
  "skip-vibe": { posix: "--skip-vibe", powershell: "-SkipVibe" },
  "skip-opencode": { posix: "--skip-opencode", powershell: "-SkipOpencode" },
  "skip-skills": { posix: "--skip-skills", powershell: "-SkipSkills" },
  "skip-claude-plugin": { posix: "--skip-claude-plugin", powershell: "-SkipClaudePlugin" },
} as const;

export type InstallFlagId = keyof typeof INSTALL_FLAG_SPELLINGS;

const MUTUALLY_EXCLUSIVE: Array<[InstallFlagId, InstallFlagId]> = [
  ["minimal", "no-minimal"],
  ["verify-attestation", "skip-attestation"],
  ["with-t3", "without-t3"],
];

function isInstallFlagId(value: unknown): value is InstallFlagId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(INSTALL_FLAG_SPELLINGS, value);
}

export interface InstallFlagsRead {
  flags: InstallFlagId[];
  /** Why the file could not be used as-is, for update.log. */
  problem?: string;
}

/**
 * Validate the parsed contents of install-flags.json. Known ids are kept in
 * allowlist order without duplicates; unknown entries are dropped; a
 * mutually-exclusive pair (which no installer writes) drops both sides.
 */
export function parseInstallFlags(raw: unknown): InstallFlagsRead {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { flags?: unknown }).flags)) {
    return { flags: [], problem: "install-flags.json is malformed" };
  }
  const entries = (raw as { flags: unknown[] }).flags;
  const present = new Set<InstallFlagId>();
  let dropped = 0;
  for (const entry of entries) {
    if (isInstallFlagId(entry)) present.add(entry);
    else dropped++;
  }
  for (const [a, b] of MUTUALLY_EXCLUSIVE) {
    if (present.has(a) && present.has(b)) {
      present.delete(a);
      present.delete(b);
      dropped += 2;
    }
  }
  const flags = (Object.keys(INSTALL_FLAG_SPELLINGS) as InstallFlagId[]).filter((id) => present.has(id));
  return dropped > 0
    ? { flags, problem: `dropped ${dropped} unrecognized or conflicting install-flags.json entr${dropped === 1 ? "y" : "ies"}` }
    : { flags };
}

/** Read install-flags.json; a missing or unreadable file means no flags. */
export function readInstallFlags(dataDir?: string): InstallFlagsRead {
  const path = join(dataDir ?? getPlannotatorDataDir(), "install-flags.json");
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { flags: [], problem: "no install-flags.json; running the installer with default flags" };
  }
  try {
    return parseInstallFlags(JSON.parse(text));
  } catch {
    return { flags: [], problem: "install-flags.json is malformed; running the installer with default flags" };
  }
}

/** The flags spelled for the installer the platform runs. */
export function installerFlagArgs(flags: readonly InstallFlagId[], platform: NodeJS.Platform): string[] {
  const key = platform === "win32" ? "powershell" : "posix";
  return flags.filter(isInstallFlagId).flatMap((id) => {
    const spelling = INSTALL_FLAG_SPELLINGS[id][key];
    return spelling === null ? [] : [spelling];
  });
}

/**
 * The install command a person runs by hand, carrying the remembered flags so
 * pasting it does not reset `install-flags.json` to the defaults.
 */
export function installCommandFor(platform: NodeJS.Platform, flags: readonly InstallFlagId[] = []): string {
  const args = installerFlagArgs(flags, platform);
  if (platform === "win32") {
    return args.length > 0
      ? `& ([scriptblock]::Create((irm ${INSTALL_PS1_URL}))) ${args.join(" ")}`
      : `irm ${INSTALL_PS1_URL} | iex`;
  }
  return args.length > 0 ? `curl -fsSL ${INSTALL_SH_URL} | bash -s -- ${args.join(" ")}` : `curl -fsSL ${INSTALL_SH_URL} | bash`;
}

// ---------------------------------------------------------------------------
// The advert: what a server tells its page
// ---------------------------------------------------------------------------

/**
 * What updating means for the host that launched this server:
 *  - `script`: the binary the install script manages; one click runs it.
 *  - `copy`: a binary the script does not manage; the page offers the command.
 *  - `pi`: the Pi extension (npm): `pi update --extensions`, then restart Pi.
 *  - `opencode`: the install script again (it clears OpenCode's plugin cache), then restart OpenCode.
 */
export type UpdateAction = "script" | "copy" | "pi" | "opencode";

export interface UpdateAdvert {
  version: string;
  current: string;
  releaseUrl: string;
  action: UpdateAction;
  /** The command a person runs (with remembered flags); present for every action. */
  command: string;
  publishedAt?: string;
}

export function buildUpdateAdvert(input: {
  state: UpdateState;
  current: string | undefined;
  action: UpdateAction;
  platform: NodeJS.Platform;
  flags?: readonly InstallFlagId[];
}): UpdateAdvert | null {
  const current = normalizeStableVersion(input.current);
  if (!current) return null;
  const latest = knownLatestRelease(input.state);
  if (!latest || !isNewerStableVersion(latest.version, current)) return null;
  return {
    version: latest.version,
    current,
    releaseUrl: releaseUrlFor(latest.version),
    action: input.action,
    command: input.action === "pi" ? PI_UPDATE_COMMAND : installCommandFor(input.platform, input.flags ?? []),
    ...(latest.publishedAt && { publishedAt: latest.publishedAt }),
  };
}

/**
 * The terminal hint (stderr, TTY only, at most once a day), read from the
 * cache. Returns the line to print and records that it printed, or null.
 */
export function takeUpdateHint(input: {
  current: string | undefined;
  enabled: boolean;
  now: number;
  dataDir?: string;
}): string | null {
  if (!input.enabled) return null;
  const current = normalizeStableVersion(input.current);
  if (!current) return null;
  try {
    const state = readUpdateState(input.dataDir);
    const latest = knownLatestRelease(state);
    if (!latest || !isNewerStableVersion(latest.version, current)) return null;
    const last = state.hintShownAt;
    if (typeof last === "number" && last <= input.now && input.now - last < UPDATE_HINT_INTERVAL_MS) return null;
    patchUpdateState((s) => ({ ...s, hintShownAt: input.now }), input.dataDir);
    return `Plannotator ${latest.version} is available (you have ${current}). Update: plannotator update`;
  } catch {
    return null;
  }
}
