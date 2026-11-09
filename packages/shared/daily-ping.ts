/**
 * The daily ping: once a UTC day per tool, one computer says "this tool ran
 * today".
 *
 * What goes out, exactly (the body's bytes, nothing else in it):
 *
 *   POST https://ping.plannotator.ai/ping
 *   content-type: application/json
 *   user-agent: plannotator
 *
 *   {"version":"0.28.46","age_week":2,"tool":"plan","first":1,"favicon":"glass"}
 *
 *  - `version`: this release (X.Y.Z only).
 *  - `age_week`: how long ago this computer first used Plannotator, in Fedora
 *    countme's buckets: 1 its first week, 2 weeks 2-4, 3 weeks 5-24, 4 older.
 *  - `tool`: inbox, plan, review, annotate or last.
 *  - `first`: 1 on this computer's first ping of the UTC day (any tool), else 0,
 *    so the server counts daily users without an ID.
 *  - `favicon`: the favicon set in Settings, read from config.json `favicon`
 *    in the data dir when the ping is sent: glass, face (the `totman` setting),
 *    p (the `classic` setting), or none when it was never picked (or holds
 *    anything else). Every tool's ping carries it; the server counts it only
 *    on the `first: 1` ping, on its own, never next to version, age or tool.
 * At most five pings a computer a day. No ID, no OS, nothing else. The server
 * adds 1 to that day's totals and keeps nothing else (apps/telemetry). It
 * still accepts the four-key body older releases send.
 *
 * When a check sends (every gate, in order):
 *  - a release build: `version` is X.Y.Z, and the build says it is a release.
 *    Only release CI says so: it defines `__PLANNOTATOR_RELEASE__=true` when it
 *    compiles the binaries (release.yml), Pi counts as one only when it does
 *    not run from this repository, and OpenCode only when release CI wrote
 *    `dist/release.json`. Every other run (a source run, a local build, a test
 *    that spawns the CLI with any `__CLI_VERSION__` and any environment) is a
 *    dev build and never reaches the real host. Under the test sandbox
 *    (PLANNOTATOR_TEST_SANDBOX, or NODE_ENV=test) it only ever sends to a
 *    loopback PLANNOTATOR_TELEMETRY_URL;
 *  - not turned off by the environment: NO_ANON_PING, the do-not-track
 *    convention, CI (config.ts parseTelemetryEnvOff). There is no config key
 *    and no Settings switch;
 *  - this tool has not sent yet today (`sent` for today's `day`);
 *  - this process holds `ping.lock` (O_EXCL, waited for up to a few seconds,
 *    stale after a minute; it holds a random token), so processes sharing a
 *    data dir send each tool's ping once and only one ping a day carries
 *    `first: 1`. A process whose lock was taken over (it slept past a minute)
 *    sends nothing more, writes nothing and leaves the other's lock alone.
 * On by default with no in-app notice (owner decision): people are told by the
 * release notes, the privacy page and the Inbox's Settings > About.
 * The POST runs in the background with a 3 s timeout. Only a 2xx records the
 * day: offline or a failure tries again at the tool's next check.
 *
 * The file, `${dataDir}/ping.json` (0600, written whole):
 *   {"firstWeek":"2026-11-02","day":"2026-11-03","sent":["plan","review"]}
 * `firstWeek` is the Monday (UTC) of the week this computer first used
 * Plannotator: when the file is new, the oldest time on the data folder or
 * anything directly in it (Plannotator wrote them), else this week. `day` and
 * `sent` are the tools already sent that UTC day.
 * Nothing else is kept. Nothing is written while the ping is off.
 *
 * Only the local Plannotator process sends, never a browser page.
 */
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseTelemetryEnvOff, type TelemetryEnvOff } from "./config";
import { getPlannotatorDataDir } from "./data-dir";

export const DAILY_PING_URL = "https://ping.plannotator.ai/ping";
export const DAILY_PING_FILE = "ping.json";
export const DAILY_PING_LOCK = "ping.lock";
export const DAILY_PING_TIMEOUT_MS = 3_000;
export const DAILY_PING_LOCK_STALE_MS = 60_000;
/** How long a check waits for another process's ping before giving up until its next check. */
export const DAILY_PING_LOCK_WAIT_MS = 5_000;

export const DAILY_PING_TOOLS = ["inbox", "plan", "review", "annotate", "last"] as const;
export type DailyPingTool = (typeof DAILY_PING_TOOLS)[number];

/** The `favicon` values a ping carries: config.json's setting, or none when it was never picked. */
export const DAILY_PING_FAVICONS = ["glass", "face", "p", "none"] as const;
export type DailyPingFavicon = (typeof DAILY_PING_FAVICONS)[number];

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyPingState {
  firstWeek?: string;
  /** The UTC day `sent` is for. */
  day?: string;
  /** The tools that sent on `day`. */
  sent?: DailyPingTool[];
}

export interface DailyPingDeps {
  /** This build's version (`__CLI_VERSION__`, the Pi or OpenCode package's); undefined for a source run. */
  version: string | undefined;
  /**
   * Whether this is a build release CI made. Default: the compiled-in mark
   * (`__PLANNOTATOR_RELEASE__`, only release.yml defines it). Pi and OpenCode
   * pass their own answer.
   */
  release?: boolean;
  tool: DailyPingTool;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  fetch?: typeof fetch;
}

export type DailyPingOff = "dev" | TelemetryEnvOff;

export type DailyPingResult = DailyPingOff | "sent-today" | "busy" | "sent" | "failed";

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

declare const __PLANNOTATOR_RELEASE__: boolean | undefined;

/** True only in a binary release CI compiled (`--define __PLANNOTATOR_RELEASE__=true`, release.yml). */
export function isMarkedReleaseBuild(): boolean {
  return typeof __PLANNOTATOR_RELEASE__ !== "undefined" && __PLANNOTATOR_RELEASE__ === true;
}

export function isReleaseVersion(version: string | undefined): version is string {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);
}

/** The exact body: the only bytes the ping carries. */
export function dailyPingBody(version: string, ageWeek: 1 | 2 | 3 | 4, tool: DailyPingTool, first: boolean, favicon: DailyPingFavicon): string {
  return JSON.stringify({ version, age_week: ageWeek, tool, first: first ? 1 : 0, favicon });
}

/** config.json's `favicon` as the ping names it: glass, totman is face, classic is p, anything else none. */
export function dailyPingFavicon(setting: unknown): DailyPingFavicon {
  if (setting === "glass") return "glass";
  if (setting === "totman") return "face";
  if (setting === "classic") return "p";
  return "none";
}

/** The favicon config.json in `dataDir` sets, read now (none when the file is missing or does not parse). */
export function readDailyPingFavicon(dataDir: string): DailyPingFavicon {
  try {
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8")) as { favicon?: unknown } | null;
    return dailyPingFavicon(config?.favicon);
  } catch {
    return "none";
  }
}

/** The CLI commands that annotate the last message (apps/hook/server/index.ts). */
const LAST_COMMANDS = ["annotate-last", "last", "opencode-annotate-last", "copilot-last"];

/**
 * The tool a CLI session counts as, from its session mode and the command it
 * ran (`args[0]`): the annotate-last commands are "last"; archive, goal setup
 * and anything else count as nothing.
 */
export function cliDailyPingTool(mode: string, command: string | undefined): DailyPingTool | null {
  if (mode === "plan") return "plan";
  if (mode === "review") return "review";
  if (mode === "annotate") return LAST_COMMANDS.includes(command ?? "") ? "last" : "annotate";
  return null;
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
 * Where this process may send, or null for nowhere. Under the test sandbox
 * only a loopback PLANNOTATOR_TELEMETRY_URL counts. Outside it, only a build
 * release CI made (`release`) reaches the real host, and the variable is
 * ignored, so nothing can redirect real pings.
 */
export function dailyPingEndpoint(version: string | undefined, env: NodeJS.ProcessEnv = process.env, release: boolean = isMarkedReleaseBuild()): string | null {
  if (!isReleaseVersion(version)) return null;
  if (env.PLANNOTATOR_TEST_SANDBOX || env.NODE_ENV === "test") return loopbackUrl(env.PLANNOTATOR_TELEMETRY_URL);
  return release ? DAILY_PING_URL : null;
}

/** Why the ping is off for this process, or null when it is on. */
export function dailyPingOff(deps: Pick<DailyPingDeps, "version" | "env" | "release">): DailyPingOff | null {
  const env = deps.env ?? process.env;
  if (!dailyPingEndpoint(deps.version, env, deps.release)) return "dev";
  return parseTelemetryEnvOff(env) ?? null;
}

// ── The file ──

function pingPath(dataDir: string): string {
  return join(dataDir, DAILY_PING_FILE);
}

export function readDailyPingState(dataDir: string = getPlannotatorDataDir()): DailyPingState {
  try {
    const raw = JSON.parse(readFileSync(pingPath(dataDir), "utf-8")) as Record<string, unknown>;
    const out: DailyPingState = {};
    if (typeof raw?.firstWeek === "string" && DAY_RE.test(raw.firstWeek)) out.firstWeek = raw.firstWeek;
    if (typeof raw?.day === "string" && DAY_RE.test(raw.day)) {
      out.day = raw.day;
      const sent = Array.isArray(raw.sent) ? raw.sent : [];
      out.sent = DAILY_PING_TOOLS.filter((t) => sent.includes(t));
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
  if (state.day) {
    ordered.day = state.day;
    ordered.sent = state.sent ?? [];
  }
  writeFileSync(tmp, `${JSON.stringify(ordered)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The week this computer first used Plannotator, for a ping.json that has no
 * `firstWeek` yet: the oldest birth or change time of the data folder and of
 * what is directly in it (Plannotator made them), never later than today.
 * Only the week is kept.
 */
export function firstUseWeek(dataDir: string, today: string): string {
  let oldest = Date.parse(`${today}T00:00:00Z`);
  const consider = (path: string) => {
    try {
      const st = lstatSync(path);
      for (const t of [st.birthtimeMs, st.mtimeMs]) if (t > 0 && t < oldest) oldest = t;
    } catch {
      // Gone, or not ours to read.
    }
  };
  consider(dataDir);
  try {
    for (const name of readdirSync(dataDir)) if (name !== DAILY_PING_FILE && name !== DAILY_PING_LOCK) consider(join(dataDir, name));
  } catch {
    // No data folder yet: this week.
  }
  return utcWeekStart(utcDay(oldest));
}

/** The tools already sent today, from the file. */
function sentToday(state: DailyPingState, today: string): DailyPingTool[] {
  return state.day === today ? (state.sent ?? []) : [];
}

// ── The lock ──

/** Create the lock holding `token`; false when another process holds it. */
function tryLock(path: string, token: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > DAILY_PING_LOCK_STALE_MS) unlinkSync(path);
    } catch {
      // Gone in between.
    }
    return false;
  }
}

interface HeldLock {
  /** Whether `ping.lock` still holds this process's token (not taken over as stale). */
  held(): boolean;
  /** Remove the lock, only while it is still this process's. */
  release(): void;
}

/** Wait (asynchronously) for `ping.lock`; null when another process held it for too long. */
async function takeLock(dataDir: string): Promise<HeldLock | null> {
  const path = join(dataDir, DAILY_PING_LOCK);
  const token = randomBytes(16).toString("hex");
  const end = Date.now() + DAILY_PING_LOCK_WAIT_MS;
  while (!tryLock(path, token)) {
    if (Date.now() >= end) return null;
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 50)));
  }
  const held = () => {
    try {
      return readFileSync(path, "utf-8") === token;
    } catch {
      return false;
    }
  };
  return {
    held,
    release() {
      if (!held()) return;
      try {
        unlinkSync(path);
      } catch {
        // Gone in between.
      }
    },
  };
}

// ── The check ──

/**
 * One check for one tool: read the file, stop when this tool already sent
 * today, else take the lock and POST once. Never throws.
 */
export async function checkDailyPing(deps: DailyPingDeps): Promise<DailyPingResult> {
  try {
    const env = deps.env ?? process.env;
    if (!DAILY_PING_TOOLS.includes(deps.tool)) return "failed";
    const off = dailyPingOff({ version: deps.version, env, release: deps.release });
    if (off) return off;
    const endpoint = dailyPingEndpoint(deps.version, env, deps.release)!;
    const dataDir = deps.dataDir ?? getPlannotatorDataDir();
    const today = utcDay(deps.now ?? Date.now());
    if (sentToday(readDailyPingState(dataDir), today).includes(deps.tool)) return "sent-today";
    // Before the lock is made: the data folder's own times say when Plannotator was first used.
    const firstUse = firstUseWeek(dataDir, today);
    mkdirSync(dataDir, { recursive: true });
    const lock = await takeLock(dataDir);
    if (!lock) return "busy";
    try {
      // Read again under the lock: another process may have sent in between.
      const state = readDailyPingState(dataDir);
      if (!state.firstWeek) {
        state.firstWeek = firstUse;
        writeDailyPingState(dataDir, state);
      }
      const sent = sentToday(state, today);
      if (sent.includes(deps.tool)) return "sent-today";
      const body = dailyPingBody(deps.version!, dailyPingAge(state.firstWeek, today), deps.tool, sent.length === 0, readDailyPingFavicon(dataDir));
      const response = await (deps.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "plannotator" },
        body,
        signal: AbortSignal.timeout(DAILY_PING_TIMEOUT_MS),
      });
      if (!response.ok) return "failed";
      // Taken over while sending (this process slept past the stale minute): the other
      // process owns the file now. Writing would drop what it recorded.
      if (!lock.held()) return "failed";
      writeDailyPingState(dataDir, { ...state, day: today, sent: DAILY_PING_TOOLS.filter((t) => t === deps.tool || sent.includes(t)) });
      return "sent";
    } finally {
      lock.release();
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
