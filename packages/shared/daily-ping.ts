/**
 * The daily ping: once a UTC day per tool, one computer says "this tool ran today". The body is exactly `{version, age_week, tool, first, favicon}`: no ID, no OS, nothing else.
 * Sends only from a release build (release CI defines `__PLANNOTATOR_RELEASE__`), and never when NO_ANON_PING, the do-not-track convention or CI is set. Under the test sandbox it only sends to a loopback PLANNOTATOR_TELEMETRY_URL.
 * `ping.lock` serializes processes sharing a data dir; a process whose lock was taken over writes and sends nothing more.
 * Only a 2xx records the day; `ping.json` keeps only the first week and the tools sent today. Only the local process sends, never a browser page.
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
export const DAILY_PING_LOCK_WAIT_MS = 5_000;

export const DAILY_PING_TOOLS = ["inbox", "plan", "review", "annotate", "last"] as const;
export type DailyPingTool = (typeof DAILY_PING_TOOLS)[number];

export const DAILY_PING_FAVICONS = ["glass", "yellow", "face", "none"] as const;
export type DailyPingFavicon = (typeof DAILY_PING_FAVICONS)[number];

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyPingState {
  firstWeek?: string;
  day?: string;
  sent?: DailyPingTool[];
}

export interface DailyPingDeps {
  version: string | undefined;
  release?: boolean;
  tool: DailyPingTool;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  fetch?: typeof fetch;
}

export type DailyPingOff = "dev" | TelemetryEnvOff;

export type DailyPingResult = DailyPingOff | "sent-today" | "busy" | "sent" | "failed";

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcWeekStart(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return utcDay(t - dow * DAY_MS);
}

export function dailyPingAge(firstWeek: string, today: string): 1 | 2 | 3 | 4 {
  const weeks = Math.round((Date.parse(`${utcWeekStart(today)}T00:00:00Z`) - Date.parse(`${firstWeek}T00:00:00Z`)) / (7 * DAY_MS));
  if (!(weeks >= 1)) return 1;
  if (weeks <= 3) return 2;
  if (weeks <= 23) return 3;
  return 4;
}

declare const __PLANNOTATOR_RELEASE__: boolean | undefined;

export function isMarkedReleaseBuild(): boolean {
  return typeof __PLANNOTATOR_RELEASE__ !== "undefined" && __PLANNOTATOR_RELEASE__ === true;
}

export function isReleaseVersion(version: string | undefined): version is string {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);
}

export function dailyPingBody(version: string, ageWeek: 1 | 2 | 3 | 4, tool: DailyPingTool, first: boolean, favicon: DailyPingFavicon): string {
  return JSON.stringify({ version, age_week: ageWeek, tool, first: first ? 1 : 0, favicon });
}

export function dailyPingFavicon(setting: unknown): DailyPingFavicon {
  if (setting === "glass") return "glass";
  if (setting === "yellow") return "yellow";
  if (setting === "totman") return "face";
  return "none";
}

export function readDailyPingFavicon(dataDir: string): DailyPingFavicon {
  try {
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8")) as { favicon?: unknown } | null;
    return dailyPingFavicon(config?.favicon);
  } catch {
    return "none";
  }
}

const LAST_COMMANDS = ["annotate-last", "last", "opencode-annotate-last", "copilot-last"];

export function cliDailyPingTool(mode: string, command: string | undefined): DailyPingTool | null {
  if (mode === "plan") return "plan";
  if (mode === "review") return "review";
  if (mode === "annotate") return LAST_COMMANDS.includes(command ?? "") ? "last" : "annotate";
  return null;
}

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

/** Under the test sandbox only a loopback PLANNOTATOR_TELEMETRY_URL counts; outside it only a release build reaches the real host and the variable is ignored, so nothing can redirect real pings. */
export function dailyPingEndpoint(version: string | undefined, env: NodeJS.ProcessEnv = process.env, release: boolean = isMarkedReleaseBuild()): string | null {
  if (!isReleaseVersion(version)) return null;
  if (env.PLANNOTATOR_TEST_SANDBOX || env.NODE_ENV === "test") return loopbackUrl(env.PLANNOTATOR_TELEMETRY_URL);
  return release ? DAILY_PING_URL : null;
}

export function dailyPingOff(deps: Pick<DailyPingDeps, "version" | "env" | "release">): DailyPingOff | null {
  const env = deps.env ?? process.env;
  if (!dailyPingEndpoint(deps.version, env, deps.release)) return "dev";
  return parseTelemetryEnvOff(env) ?? null;
}

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

function sentToday(state: DailyPingState, today: string): DailyPingTool[] {
  return state.day === today ? (state.sent ?? []) : [];
}

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
  held(): boolean;
  release(): void;
}

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

export function scheduleDailyPing(deps: DailyPingDeps): void {
  const timer = setTimeout(() => {
    void checkDailyPing(deps).catch(() => {});
  }, 0);
  (timer as { unref?: () => void }).unref?.();
}
