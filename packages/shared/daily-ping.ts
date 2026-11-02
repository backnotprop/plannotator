/**
 * The daily ping: once a UTC day, one computer says "Plannotator ran today".
 *
 * What goes out, exactly (the body's bytes, nothing else in it):
 *
 *   POST https://ping.plannotator.ai/ping
 *   content-type: application/json
 *   user-agent: plannotator
 *
 *   {"version":"0.28.46","age":2}
 *
 * `version` is this release (X.Y.Z only). `age` is how long ago this computer
 * first used Plannotator, in Fedora countme's buckets: 1 its first week,
 * 2 weeks 2-4, 3 weeks 5-24, 4 older. No ID, no OS, no feature data. The
 * server adds 1 to that day's (version, age) total and keeps nothing else
 * (apps/telemetry).
 *
 * When a check sends (every gate, in order):
 *  - a release build: `version` is X.Y.Z (a source run, a dev or test build
 *    sends nothing). Under the test sandbox (PLANNOTATOR_TEST_SANDBOX, or
 *    NODE_ENV=test) it only ever sends to a loopback PLANNOTATOR_TELEMETRY_URL,
 *    never to the real host;
 *  - not turned off: DO_NOT_TRACK, NO_ANON_PING, CI, config.json
 *    `telemetry: false` (Settings writes it) — config.ts resolveTelemetry;
 *  - the notice was shown (`noticeDay`) on an earlier UTC day: nothing is sent
 *    on the day the notice first appeared;
 *  - not sent yet today (`lastDay`);
 *  - this process holds `ping.lock` (O_EXCL; stale after a minute), so
 *    processes sharing a data dir send once.
 * The POST is fire-and-forget with a 3 s timeout. Only a 2xx writes today
 * into `lastDay`: offline or a failure tries again at the next check.
 *
 * The file, `${dataDir}/ping.json` (0600, written whole):
 *   {"firstWeek":"2026-11-02","noticeDay":"2026-11-02","lastDay":"2026-11-03"}
 * `firstWeek` is the Monday (UTC) of the week this computer first checked with
 * the ping on. Nothing else is kept. Nothing is written while the ping is off.
 *
 * Only the local Plannotator process sends, never a browser page.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, parseTelemetryEnvOff, resolveTelemetry, type TelemetryEnvOff } from "./config";
import { getPlannotatorDataDir } from "./data-dir";

export const DAILY_PING_URL = "https://ping.plannotator.ai/ping";
export const DAILY_PING_FILE = "ping.json";
export const DAILY_PING_LOCK = "ping.lock";
export const DAILY_PING_TIMEOUT_MS = 3_000;
export const DAILY_PING_LOCK_STALE_MS = 60_000;
export const DAILY_PING_PRIVACY_URL = "https://plannotator.ai/privacy";

/**
 * The one-time notice, as the CLI prints it (one stderr line) and the Inbox
 * shows it (a toast). Wording is the owner's call (privacy-critical copy).
 */
export const DAILY_PING_NOTICE =
  "Plannotator sends one private daily ping: its version and roughly how long it has been installed. No ID, nothing about you or your work. Turn it off in Settings, or with NO_ANON_PING=1.";

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyPingState {
  firstWeek?: string;
  noticeDay?: string;
  lastDay?: string;
}

export interface DailyPingDeps {
  /** This build's version (`__CLI_VERSION__`, the Pi or OpenCode package's); undefined for a source run. */
  version: string | undefined;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  fetch?: typeof fetch;
}

export type DailyPingOff = "dev" | TelemetryEnvOff | "config";

export type DailyPingResult =
  | DailyPingOff
  | "no-notice"
  | "notice-today"
  | "sent-today"
  | "busy"
  | "sent"
  | "failed";

// ── Days ──

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The Monday (UTC) of the week `day` falls in. */
export function utcWeekStart(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return utcDay(t - dow * DAY_MS);
}

/** Fedora countme's install-age bucket: 1 first week, 2 weeks 2-4, 3 weeks 5-24, 4 older. */
export function dailyPingAge(firstWeek: string, today: string): 1 | 2 | 3 | 4 {
  const weeks = Math.round((Date.parse(`${utcWeekStart(today)}T00:00:00Z`) - Date.parse(`${firstWeek}T00:00:00Z`)) / (7 * DAY_MS));
  if (!(weeks >= 1)) return 1;
  if (weeks <= 3) return 2;
  if (weeks <= 23) return 3;
  return 4;
}

export function isReleaseVersion(version: string | undefined): version is string {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);
}

/** The exact body: the only bytes the ping carries. */
export function dailyPingBody(version: string, age: 1 | 2 | 3 | 4): string {
  return JSON.stringify({ version, age });
}

// ── Where, and whether ──

/** `<origin>/ping` for a loopback http origin, or null. */
function loopbackUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    return url.protocol === "http:" && loopback && !url.username && !url.password ? `${url.origin}/ping` : null;
  } catch {
    return null;
  }
}

/**
 * Where this process may send, or null for nowhere. Only a release build
 * sends. Under the test sandbox only a loopback PLANNOTATOR_TELEMETRY_URL
 * counts, so a test never reaches the real host; outside it the variable is
 * ignored, so nothing can redirect real pings.
 */
export function dailyPingEndpoint(version: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isReleaseVersion(version)) return null;
  if (env.PLANNOTATOR_TEST_SANDBOX || env.NODE_ENV === "test") return loopbackUrl(env.PLANNOTATOR_TELEMETRY_URL);
  return DAILY_PING_URL;
}

/** Why the ping is off for this process, or null when it is on (the notice and the day still apply). */
export function dailyPingOff(deps: Pick<DailyPingDeps, "version" | "env">): DailyPingOff | null {
  const env = deps.env ?? process.env;
  if (!dailyPingEndpoint(deps.version, env)) return "dev";
  const envOff = parseTelemetryEnvOff(env);
  if (envOff) return envOff;
  if (!resolveTelemetry(loadConfig(), env)) return "config";
  return null;
}

// ── The file ──

function pingPath(dataDir: string): string {
  return join(dataDir, DAILY_PING_FILE);
}

export function readDailyPingState(dataDir: string = getPlannotatorDataDir()): DailyPingState {
  try {
    const raw = JSON.parse(readFileSync(pingPath(dataDir), "utf-8")) as Record<string, unknown>;
    const out: DailyPingState = {};
    for (const key of ["firstWeek", "noticeDay", "lastDay"] as const) {
      const v = raw?.[key];
      if (typeof v === "string" && DAY_RE.test(v)) out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeDailyPingState(dataDir: string, state: DailyPingState): void {
  mkdirSync(dataDir, { recursive: true });
  const path = pingPath(dataDir);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const ordered: DailyPingState = {};
  if (state.firstWeek) ordered.firstWeek = state.firstWeek;
  if (state.noticeDay) ordered.noticeDay = state.noticeDay;
  if (state.lastDay) ordered.lastDay = state.lastDay;
  writeFileSync(tmp, `${JSON.stringify(ordered)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Read the file, recording this week as the first-use week when none is there yet. */
function readWithFirstWeek(dataDir: string, today: string): DailyPingState {
  const state = readDailyPingState(dataDir);
  if (!state.firstWeek) {
    state.firstWeek = utcWeekStart(today);
    writeDailyPingState(dataDir, state);
  }
  return state;
}

// ── The notice ──

/** The notice is waiting to be shown: the ping is on here and no notice was ever shown. */
export function dailyPingNoticeDue(deps: DailyPingDeps): boolean {
  try {
    if (dailyPingOff(deps)) return false;
    return !readDailyPingState(deps.dataDir ?? getPlannotatorDataDir()).noticeDay;
  } catch {
    return false;
  }
}

/**
 * The surface about to show the notice claims it: records today as the
 * notice day and answers true, once. False when it is not due, or when the
 * file could not be written (showing it anyway would show it every time).
 */
export function claimDailyPingNotice(deps: DailyPingDeps): boolean {
  try {
    if (!dailyPingNoticeDue(deps)) return false;
    const dataDir = deps.dataDir ?? getPlannotatorDataDir();
    const today = utcDay(deps.now ?? Date.now());
    const state = readWithFirstWeek(dataDir, today);
    if (state.noticeDay) return false;
    writeDailyPingState(dataDir, { ...state, noticeDay: today });
    return readDailyPingState(dataDir).noticeDay === today;
  } catch {
    return false;
  }
}

// ── The lock ──

function takeLock(dataDir: string): (() => void) | null {
  const path = join(dataDir, DAILY_PING_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // Taken over as stale.
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs <= DAILY_PING_LOCK_STALE_MS) return null;
        unlinkSync(path);
      } catch {
        // Gone in between: try once more.
      }
    }
  }
  return null;
}

// ── The check ──

/**
 * One check: read the file, stop when today is done or the notice is not old
 * enough, else take the lock and POST once. Never throws.
 */
export async function checkDailyPing(deps: DailyPingDeps): Promise<DailyPingResult> {
  try {
    const env = deps.env ?? process.env;
    const off = dailyPingOff({ version: deps.version, env });
    if (off) return off;
    const endpoint = dailyPingEndpoint(deps.version, env)!;
    const dataDir = deps.dataDir ?? getPlannotatorDataDir();
    const now = deps.now ?? Date.now();
    const today = utcDay(now);
    const state = readWithFirstWeek(dataDir, today);
    if (state.lastDay === today) return "sent-today";
    if (!state.noticeDay) return "no-notice";
    if (state.noticeDay >= today) return "notice-today";
    const release = takeLock(dataDir);
    if (!release) return "busy";
    try {
      // Another process may have sent between the read and the lock.
      const fresh = readDailyPingState(dataDir);
      if (fresh.lastDay === today) return "sent-today";
      const body = dailyPingBody(deps.version!, dailyPingAge(fresh.firstWeek ?? state.firstWeek!, today));
      const response = await (deps.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "plannotator" },
        body,
        signal: AbortSignal.timeout(DAILY_PING_TIMEOUT_MS),
      });
      if (!response.ok) return "failed";
      writeDailyPingState(dataDir, { ...readDailyPingState(dataDir), lastDay: today });
      return "sent";
    } finally {
      release();
    }
  } catch {
    return "failed";
  }
}

/** Run a check in the background: never awaited, never throws, never delays the caller. */
export function scheduleDailyPing(deps: DailyPingDeps): void {
  const timer = setTimeout(() => {
    void checkDailyPing(deps).catch(() => {});
  }, 0);
  (timer as { unref?: () => void }).unref?.();
}
