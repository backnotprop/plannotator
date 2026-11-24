import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, constants as fsConstants } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { inboxLaunchTokenOk, openCodeSessionModel, parseOpenCodeAgents, parseOpenCodeDefaultModel, parseOpenCodeModels, type InboxLaunchChoices, type InboxLaunchChoicesUnread } from "@plannotator/core/inbox-launch-choice";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { OPENCODE_LAUNCH_ENV, OPENCODE_LAUNCH_SESSION_ENV, openCodeSessionIdOk } from "@plannotator/shared/inbox/opencode-launch";
import { stripJsonComments } from "./agent-files";
import { agentVersionRun, createAgentEnvironmentFor, openCodeGeneration, openCodePluginInstalled, type AgentEnvironment, type AgentRunResult } from "./inbox-agents";
import { LAUNCH_CHOICES_RUN_MS, launchChoiceCache } from "./inbox-launch-choice";
import { shellQuote, versionAtLeast } from "./inbox-launch-claude";
import { LOGIN_ENV_FALLBACKS, launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import { launchNoteText, writeLaunchNote, type LaunchAvailability, type LaunchHost, type LaunchHostContext, type LaunchHostResult, type LaunchLive, type LaunchPermissionContext, type LaunchStartFailure } from "./inbox-launch-host";
import { createOpenCodePermissions, OPENCODE, OPENCODE_NAME, type OpenCodePermissionAsked } from "./inbox-launch-opencode-permission";
import { openCodeConfigFiles } from "./inbox-restart";

export { OPENCODE, OPENCODE_NAME };
export const OPENCODE_LAUNCH_MIN_VERSION = "2.0.19";
export const OPENCODE_STOPPED_NOTE = "The Inbox restarted, which ended it. Your reply continues it.";
export const OPENCODE_PLUGIN_UPDATE = "opencode2 plugin update @plannotator/opencode";

const READY_MS = 30_000;
const PLUGIN_MS = 60_000;
const REQUEST_MS = 15_000;
const STOP_MS = 5_000;
const NOTE_ERROR_MAX = 300;
const NOTE_TITLE_MAX = 80;

export function openCodeCause(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return !line ? "" : /[.!?]$/.test(line) ? line : `${line}.`;
}

export function parseOpenCodeVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
}

export function installedOpenCodePlugin(cacheHome: string): { version: string; launches: boolean } | null {
  const root = join(cacheHome, "opencode", "npm", "@plannotator");
  let specs: string[] = [];
  try {
    specs = readdirSync(root).filter((name) => name === "opencode" || name.startsWith("opencode@"));
  } catch {
    return null;
  }
  let best: { version: string; launches: boolean } | null = null;
  for (const spec of specs) {
    let generations: string[] = [];
    try {
      generations = readdirSync(join(root, spec)).sort((a, b) => Number(b) - Number(a) || b.localeCompare(a));
    } catch {
      continue;
    }
    for (const generation of generations) {
      const dir = join(root, spec, generation, "node_modules", "@plannotator", "opencode");
      try {
        const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
        if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) continue;
        const launches = readFileSync(join(dir, "dist", "server.js"), "utf8").includes(OPENCODE_LAUNCH_ENV);
        if (!best || versionAtLeast(version, best.version)) best = { version, launches };
        break;
      } catch {}
    }
  }
  return best;
}

export function openCodeSpawnEnv(login: Readonly<LaunchEnv>, dataDir: string | null, session: string | null, password: string): LaunchEnv {
  const env = Object.fromEntries(Object.entries(launchSpawnEnv(login)).filter(([name]) => name !== "OPENCODE" && !name.startsWith("OPENCODE_SERVER_")));
  return {
    ...env,
    PLANNOTATOR_INBOX_TOOL: "1",
    [OPENCODE_LAUNCH_ENV]: "1",
    ...(session ? { [OPENCODE_LAUNCH_SESSION_ENV]: session } : {}),
    ...(dataDir ? { PLANNOTATOR_DATA_DIR: dataDir } : {}),
    // OpenCode 2 checks the current name before the legacy server password.
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
  };
}

function openCodeTerminalRun(bin: string, session: string, dataDir: string | null): string {
  return `PLANNOTATOR_INBOX_TOOL=1 ${OPENCODE_LAUNCH_SESSION_ENV}=${shellQuote(session)} ${dataDir ? `PLANNOTATOR_DATA_DIR=${shellQuote(dataDir)} ` : ""}${bin} --standalone --session ${shellQuote(session)}`;
}

export function openCodeAttachCommand(bin: string, folder: string, session: string, dataDir: string | null = null): string {
  return `/bin/sh -c ${shellQuote(`cd ${shellQuote(folder)} && ${openCodeTerminalRun(bin, session, dataDir)}`)}`;
}

export function openCodeHandoffCommand(bin: string, folder: string, session: string, pid: number, dataDir: string | null = null): string {
  return `/bin/sh -c ${shellQuote(`cd ${shellQuote(folder)} || exit 1; while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; ${openCodeTerminalRun(bin, session, dataDir)}`)}`;
}

/**
 * The words of a failed turn's error: a string as it is; OpenCode's nested error (`{ name, data: { message } }`) by
 * `data.message`, then `message`, then `name`. Never "[object Object]": empty when none of them is words.
 */
export function openCodeErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if ((typeof error === "number" && Number.isFinite(error)) || typeof error === "boolean") return String(error);
  if (!error || typeof error !== "object") return "";
  const e = error as { name?: unknown; message?: unknown; data?: unknown };
  const nested = e.data && typeof e.data === "object" ? (e.data as { message?: unknown }).message : undefined;
  for (const text of [nested, e.message, e.name]) if (typeof text === "string" && text.trim()) return text;
  return "";
}

/** A failed turn's words from OpenCode's `session.execution.failed` data: its `error`, else its `message`. */
export function openCodeFailedTurnText(data: { error?: unknown; message?: unknown }): string {
  return openCodeErrorText(data.error) || openCodeErrorText(data.message);
}

/**
 * What each list read keeps of OpenCode's output, in UTF-16 code units (JavaScript string length, not bytes): about
 * 16 million characters. A gateway provider (Vercel's, OpenRouter) lists hundreds of models, past the 64 Ki default.
 */
export const OPENCODE_LIST_OUTPUT_CAP = 16 * 1024 * 1024;
/** A list read that failed (a slow first run, a config mid-edit) is tried again this soon, doubling up to 5 minutes. */
const LIST_FAILED_AGAIN_MS = 15_000;
const LIST_FAILED_AGAIN_MAX_MS = 5 * 60_000;
/** Between a list key's parts: never in a path. */
const LIST_KEY_CUT = "\u0000";
/** A list read that found no login env runs the login shell again at most this often. */
const LIST_LOGIN_AGAIN_MS = 5 * 60_000;
/** The login shell's names this host keeps (`shellNames`): where OpenCode's files are, and an explicit config. */
const OPENCODE_SHELL_NAMES = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"] as const;

/**
 * The env OpenCode's lists are read with: the login env through the launch filter (`launchSpawnEnv`), so a key or an
 * `OPENCODE_CONFIG` the person's shell sets counts as it does in the session. No `OPENCODE`, no `OPENCODE_SERVER_*`
 * and no `PLANNOTATOR_*` name: OpenCode may load Plannotator's plugin for the read, and it must not act as a session.
 */
export function openCodeListEnv(login: Readonly<LaunchEnv>): LaunchEnv {
  return Object.fromEntries(Object.entries(launchSpawnEnv(login)).filter(([name]) => name !== "OPENCODE" && !name.startsWith("OPENCODE_SERVER_") && !name.startsWith("PLANNOTATOR_")));
}

/**
 * What OpenCode's lists depend on besides its binary: its config files (`OPENCODE_CONFIG`, then the global folder's)
 * and its sign-in file. Only their change time and size, from `stat`: the sign-in file is never read.
 */
export function openCodeListStamp(e: AgentEnvironment): string {
  const data = e.env.XDG_DATA_HOME?.trim();
  const dataHome = data && isAbsolute(data) ? data : join(e.homeDir, ".local", "share");
  return [...openCodeConfigFiles(e), join(dataHome, "opencode", "auth.json")]
    .map((file) => {
      try {
        const stat = statSync(file);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return "-";
      }
    })
    .join(",");
}

/** A project config file bigger than this is not read (its folder's default is then not named). */
export const OPENCODE_PROJECT_CONFIG_CAP = 256 * 1024;
/** A project's own OpenCode config files, in each folder from the one picked up to its git root (OpenCode's names). */
const OPENCODE_PROJECT_CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;

/** `path` is `root` or inside it (both real paths). */
const insideOf = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
/** `lstat`, never following a link; null when nothing is there (or it can't be looked at). */
const there = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

export type OpenCodeProjectModel = { kind: "model"; model: string } | { kind: "none" } | { kind: "unsure" };

/**
 * The model a project's own OpenCode config sets (`model`, provider/id), read as DATA: nothing of the project runs,
 * no plugin and no `.opencode` folder is loaded. Picking a folder in To must never run its code (OpenCode run there
 * would load its config and plugins), so OpenCode is never asked there.
 *
 * Reads `opencode.jsonc` and `opencode.json` in `folder` and each folder above it up to its git root (a `.git` there),
 * never above `home`; the nearest sets it. `none`: no project file sets `model` (OpenCode's own default, read in the
 * home folder, names it). `unsure` whenever the name could be wrong: a config file present but unreadable, invalid,
 * over 256 KiB, not a plain file or a link out of that tree; a `model` that is not a plain provider/id token; files
 * that set different models where which wins is not certain; a project file that also sets an agent's model or
 * changes the providers; a `.opencode/opencode.json(c)` (seen, never read); `OPENCODE_CONFIG_CONTENT` set with a
 * project `model`. A folder outside home (or not there) is not read: `unsure`.
 */
export function openCodeProjectModel(folder: string, home: string, options: { configContent?: boolean } = {}): OpenCodeProjectModel {
  const unsure = { kind: "unsure" } as const;
  let top: string;
  let start: string;
  try {
    top = realpathSync(home);
    start = realpathSync(folder);
  } catch {
    return unsure;
  }
  if (!insideOf(start, top)) return unsure;
  // The folders OpenCode would look in: the one picked, then up to its git root, never above home.
  const dirs: string[] = [];
  for (let dir = start; ; ) {
    dirs.push(dir);
    if (dir === top || there(join(dir, ".git"))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const root = dirs[dirs.length - 1]!;
  const found: { at: number; name: string; model: string }[] = [];
  let changesProviders = false;
  for (const [at, dir] of dirs.entries()) {
    // Seen, never read: an `.opencode` folder's own config (a link there is not followed, so it may hold one).
    const dotFolder = there(join(dir, ".opencode"));
    if (dotFolder?.isSymbolicLink()) return unsure;
    if (dotFolder?.isDirectory() && OPENCODE_PROJECT_CONFIG_NAMES.some((name) => there(join(dir, ".opencode", name)))) return unsure;
    for (const name of OPENCODE_PROJECT_CONFIG_NAMES) {
      const read = readProjectConfig(join(dir, name), root);
      if (read === null) continue;
      if (read === false) return unsure;
      if (read.agentModel) return unsure;
      if (read.changesProviders) changesProviders = true;
      if (read.model === false) return unsure;
      if (read.model !== null) found.push({ at, name, model: read.model });
    }
  }
  if (found.length === 0) return changesProviders ? unsure : { kind: "none" };
  if (options.configContent) return unsure;
  const nearest = found[0]!;
  // Nearest wins between files of one name; files of the two names that disagree: which wins is not certain.
  if (found.some((f) => f.model !== nearest.model && (f.at === nearest.at || f.name !== nearest.name))) return unsure;
  return { kind: "model", model: nearest.model };
}

/**
 * One project config file as data. null: not there. false: there, but not read (unreadable, too big, not a plain file,
 * a link out of `root`, not a JSON object). `model`: its top-level `model` (null: none; false: not a provider/id token).
 */
function readProjectConfig(path: string, root: string): { model: string | null | false; agentModel: boolean; changesProviders: boolean } | null | false {
  let at = path;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) {
      at = realpathSync(path);
      if (!insideOf(at, root)) return false;
    } else if (!link.isFile()) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? null : false;
  }
  let text: string;
  let fd: number | null = null;
  try {
    // Non-blocking: a named pipe at this path would otherwise hold the open, and the whole server with it.
    fd = openSync(at, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > OPENCODE_PROJECT_CONFIG_CAP) return false;
    const buffer = Buffer.alloc(OPENCODE_PROJECT_CONFIG_CAP + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, size);
      if (n <= 0) break;
      size += n;
    }
    if (size > OPENCODE_PROJECT_CONFIG_CAP) return false;
    text = buffer.subarray(0, size).toString("utf8").replace(/^\uFEFF/, "");
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const config = parsed as Record<string, unknown>;
  const agents = config.agent;
  const agentModel = !!agents && typeof agents === "object" && Object.values(agents).some((agent) => !!agent && typeof agent === "object" && "model" in agent);
  const changesProviders = "provider" in config || "enabled_providers" in config || "disabled_providers" in config;
  if (!("model" in config)) return { model: null, agentModel, changesProviders };
  const model = config.model;
  const ok = typeof model === "string" && inboxLaunchTokenOk(model) && /^[^/]+\/.+$/.test(model);
  return { model: ok ? model : false, agentModel, changesProviders };
}

/** OpenCode's lists when they could not be read: empty, with why, as a code (the window has the words). */
export function openCodeUnread(why: InboxLaunchChoicesUnread): Omit<InboxLaunchChoices, "last"> {
  return { models: [], efforts: [], effort_word: "Variant", unread: why };
}

/** The lists while they are being read (a read longer than the offer's wait): the menu has Default and says so. */
export const OPENCODE_CHOICES_READING: Omit<InboxLaunchChoices, "last"> = { models: [], efforts: [], effort_word: "Variant", reading: true };

/** Why a model list run failed, or null when it ran. Never its output: a code only. */
export function openCodeListFailure(ran: AgentRunResult | null): InboxLaunchChoicesUnread | null {
  if (!ran) return "not_started";
  if (ran.timedOut) return "timeout";
  if (ran.exitCode === 127) return "not_started";
  if (ran.exitCode !== 0) return "exit";
  return null;
}

export function openCodeTurnErrorNote(error: string): string {
  const shown = launchNoteText(error, NOTE_ERROR_MAX);
  return shown ? `OpenCode's turn ended with an error: ${shown}` : "OpenCode's turn ended with an error.";
}

export function openCodeFormNote(title: unknown): string {
  const shown = launchNoteText(title, NOTE_TITLE_MAX);
  return shown ? `OpenCode asked something the Inbox can't show yet (“${shown}”); answered Cancel.` : "OpenCode asked something the Inbox can't show yet; answered Cancel.";
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? done(address.port) : fail(new Error("no port"))));
    });
  });

type Ending = "stop" | "handoff" | "restart" | "close";

interface OpenCodeServer {
  launchId: string;
  folder: string;
  session: string | null;
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  auth: string;
  exited: boolean;
  exitCode: number | null;
  ending: Ending | null;
  busySince: number | null;
  stderr: string;
  ended: Promise<number>;
  events: AbortController;
}

interface Spawning {
  cancel: "stop" | "handoff" | null;
  done: Promise<void>;
}

export function createOpenCodeLaunchHost(ctx: LaunchHostContext, options: { readyMs?: number; pluginMs?: number } = {}) {
  const readyMs = options.readyMs ?? READY_MS;
  const pluginMs = options.pluginMs ?? PLUGIN_MS;
  const dataDirArg = () => (resolve(ctx.dataDir) === resolve(getDefaultPlannotatorDataDir(ctx.homeDir)) ? null : ctx.dataDir);
  const cacheHome = () => ctx.shell()?.XDG_CACHE_HOME ?? ctx.ownEnv().XDG_CACHE_HOME ?? join(ctx.homeDir, ".cache");
  const binOf = (e: AgentEnvironment): string | null => e.which("opencode2") ?? (openCodeGeneration(e) === "2" ? e.which("opencode") : null);

  const procs = new Map<string, OpenCodeServer>();
  /** Every server this host runs, one still making its session (not in `procs` yet) included: `close` ends them all. */
  const serving = new Set<OpenCodeServer>();
  const spawning = new Map<string, Spawning>();
  let threads: LaunchPermissionContext | null = null;
  let permissions: ReturnType<typeof createOpenCodePermissions> | null = null;
  let notes = 0;

  const running = (session: string): OpenCodeServer | null => {
    const s = procs.get(session);
    return s && !s.exited ? s : null;
  };

  const call = async (s: OpenCodeServer, method: string, route: string, body?: unknown, ms = REQUEST_MS): Promise<Response> =>
    fetch(`${s.url}${route}`, {
      method,
      headers: { authorization: s.auth, "x-opencode-directory": encodeURIComponent(s.folder), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
  const json = async <T>(s: OpenCodeServer, method: string, route: string, body?: unknown): Promise<T> => {
    const response = await call(s, method, route, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  const note = (launchId: string, session: string, body: string, key: string) => {
    const root = threads?.rootOf(launchId);
    if (!threads || !root) return;
    writeLaunchNote(threads, root, { author: { host: OPENCODE, session, name: OPENCODE_NAME }, body, key }, ctx.log);
  };

  const onEvent = (s: OpenCodeServer, event: { type?: unknown; data?: Record<string, any> }) => {
    const data = event.data ?? {};
    if (!s.session || data.sessionID !== s.session) return;
    switch (event.type) {
      case "session.execution.started":
        s.busySince ??= Date.now();
        threads?.onChange();
        return;
      case "session.execution.failed": {
        s.busySince = null;
        const text = openCodeFailedTurnText(data);
        if (existsSync(ctx.launchDir(s.launchId))) ctx.startLog(s.launchId, `opencode ${s.session}: the turn ended with an error: ${text.slice(0, 2000)}`);
        note(s.launchId, s.session, openCodeTurnErrorNote(text), `opencode-error-${s.launchId}-${Date.now()}-${++notes}`);
        threads?.onChange();
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        s.busySince = null;
        threads?.onChange();
        return;
      case "permission.asked":
        if (typeof data.id === "string" && Array.isArray(data.resources) && typeof data.action === "string") permissions?.asked(s, data as OpenCodePermissionAsked);
        return;
      case "permission.replied":
        if (typeof data.requestID === "string") permissions?.replied(data.requestID);
        return;
      case "form.created": {
        const id = data.id ?? data.formID;
        if (typeof id !== "string") return;
        void call(s, "DELETE", `/api/session/${s.session}/form/${encodeURIComponent(id)}`).catch(() => undefined);
        ctx.startLog(s.launchId, `opencode form ${id} answered cancelled`);
        note(s.launchId, s.session, openCodeFormNote(data.title ?? data.questions?.[0]?.question), `opencode-form-${s.launchId}-${id}`);
        return;
      }
    }
  };

  const listen = (s: OpenCodeServer) => {
    void (async () => {
      try {
        const response = await fetch(`${s.url}/api/event`, { headers: { authorization: s.auth }, signal: s.events.signal });
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data) continue;
            try {
              onEvent(s, JSON.parse(data));
            } catch {}
          }
        }
      } catch {
      }
    })();
  };

  type SpawnResult = { ok: true; server: OpenCodeServer } | { ok: false; cancelled: boolean; missing: boolean; text: string; output: string };

  const spawnServer = async (launch: InboxLaunchRecord, session: string | null, login: Readonly<LaunchEnv>, cancelled: () => boolean): Promise<SpawnResult> => {
    const password = randomBytes(24).toString("base64url");
    const env = openCodeSpawnEnv(login.PATH ? login : ((await ctx.environment()).env as LaunchEnv), dataDirArg(), session, password);
    const path = binOf(await ctx.environment());
    if (!path) return { ok: false, cancelled: false, missing: true, text: "opencode2 is not on the Inbox's PATH.", output: "opencode2 not found" };
    if (cancelled()) return { ok: false, cancelled: true, missing: false, text: "", output: "" };
    const port = await freePort();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([path, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: launch.folder, env, stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, cancelled: false, missing: false, text: openCodeCause(text), output: text };
    }
    const s: OpenCodeServer = { launchId: launch.id, folder: launch.folder, session, proc, url: `http://127.0.0.1:${port}`, auth: `Basic ${btoa(`opencode:${password}`)}`, exited: false, exitCode: null, ending: null, busySince: null, stderr: "", ended: null as never, events: new AbortController() };
    s.ended = proc.exited.then((code) => {
      s.exited = true;
      s.exitCode = code;
      s.busySince = null;
      s.events.abort();
      permissions?.processEnded(s);
      if (existsSync(ctx.launchDir(launch.id))) ctx.startLog(launch.id, `opencode serve ${s.session ?? ""}: exited ${code}${s.ending ? ` (${s.ending})` : ""}${s.stderr.trim() ? `\n[stderr]\n${s.stderr.trim().slice(-2000)}` : ""}`);
      threads?.onChange();
      return code;
    });
    if (session) procs.set(session, s);
    serving.add(s);
    void s.ended.then(() => serving.delete(s));
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) s.stderr = `${s.stderr}${decoder.decode(chunk, { stream: true })}`.slice(-8000);
      } catch {}
    })();
    const fail = async (why: string): Promise<SpawnResult> => {
      const endedItself = s.exited;
      if (!s.exited) proc.kill("SIGTERM");
      await Promise.race([s.ended, Bun.sleep(2_000)]);
      if (session && procs.get(session) === s) procs.delete(session);
      const said = endedItself ? s.stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) : undefined;
      return { ok: false, cancelled: false, missing: false, text: openCodeCause(why || said || "It exited before it answered"), output: `opencode serve\n${s.stderr.trim().slice(-2000)}` };
    };
    const until = Date.now() + readyMs;
    for (;;) {
      if (s.exited) return fail("");
      const answer = await call(s, "GET", "/api/info", undefined, 2_000).catch(() => null);
      if (answer?.ok) break;
      if (Date.now() > until) return fail(`OpenCode did not answer within ${Math.round(readyMs / 1000)} s`);
      await Bun.sleep(50);
    }
    const pluginUntil = Date.now() + pluginMs;
    for (;;) {
      if (s.exited) return fail("");
      const listed = await json<{ data?: { id?: string; state?: { status?: unknown; error?: unknown } }[] }>(s, "GET", "/api/plugin").catch(() => null);
      const ours = listed?.data?.find((plugin) => plugin.id === "plannotator");
      if (ours?.state?.status === "failed") return fail(`Plannotator's OpenCode plugin did not load: ${String(ours.state.error ?? "")}`);
      if (ours?.state?.status === "active") break;
      if (Date.now() > pluginUntil) return fail("Plannotator's OpenCode plugin did not load in OpenCode");
      await Bun.sleep(100);
    }
    listen(s);
    ctx.startLog(launch.id, `opencode serve on ${s.url} in ${launch.folder}${session ? `, session ${session}` : ""}: ready`);
    return { ok: true, server: s };
  };

  const end = async (s: OpenCodeServer, why: Ending): Promise<number | null> => {
    if (s.exited) return s.exitCode;
    s.ending ??= why;
    if (s.session && s.busySince !== null) await call(s, "POST", `/api/session/${s.session}/interrupt`, {}, STOP_MS).catch(() => undefined);
    s.proc.kill("SIGTERM");
    const code = await Promise.race([s.ended, Bun.sleep(STOP_MS).then(() => null)]);
    if (code !== null) return code;
    s.proc.kill("SIGKILL");
    return Promise.race([s.ended, Bun.sleep(2_000).then(() => null)]);
  };

  const sessionModel = async (s: OpenCodeServer, launch: InboxLaunchRecord) => {
    if (!launch.model && !launch.effort) return null;
    if (launch.model) return openCodeSessionModel(launch.model, launch.effort);
    const fallback = await json<{ data?: { providerID?: string; id?: string } }>(s, "GET", "/api/model/default").catch(() => null);
    return openCodeSessionModel(fallback?.data?.providerID && fallback.data.id ? `${fallback.data.providerID}/${fallback.data.id}` : undefined, launch.effort);
  };

  type ResumeResult = LaunchHostResult & { failure: { code: "untrusted" | "failed"; text: string } | null };
  const nothing = (text: string): ResumeResult => ({ exitCode: 0, text, failure: null });

  /** OpenCode's session for a launch, on a server made for it: `start` keeps that server, `rexCommand` ends it. */
  const makeSession = async (launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }): Promise<{ ok: true; session: string; server: OpenCodeServer } | ({ ok: false } & LaunchStartFailure)> => {
    const result = await spawnServer(launch, null, input.login, () => false);
    if (!result.ok) {
      ctx.startLog(launch.id, result.output);
      return { ok: false as const, code: result.missing ? ("missing" as const) : ("failed" as const), text: result.text };
    }
    const s = result.server;
    const failed = async (text: string) => {
      await end(s, "close");
      return { ok: false as const, code: "failed" as const, text: openCodeCause(text) };
    };
    const model = await sessionModel(s, launch);
    if (launch.model && !model) return failed("OpenCode takes a model as provider/model, such as opencode/big-pickle");
    // OpenCode's own agent (build, plan, …) as picked beside the model; absent, OpenCode's default.
    const agent = inboxLaunchTokenOk(launch.primary_agent) ? launch.primary_agent : null;
    const created = await json<{ data?: { id?: unknown } }>(s, "POST", "/api/session", {
      location: { directory: launch.folder },
      title: input.name.trim() || "Inbox",
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
    }).catch((error: unknown) => {
      ctx.startLog(launch.id, `POST /api/session: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const session = created?.data?.id;
    if (!openCodeSessionIdOk(session)) return failed("OpenCode did not make a session");
    s.session = session;
    ctx.startLog(launch.id, `session ${session}${model ? ` on ${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : ""}${agent ? `, agent ${agent}` : ""}`);
    return { ok: true as const, session, server: s };
  };

  let binName = "opencode2";
  let choiceKey: string | null = null;
  /**
   * The env of the last login read this host had (any login read the Inbox made, `loginRead`; a start's; a resume's; or
   * its own): list reads reuse it, so they don't run the person's login shell (their rc files) for each read. Memory
   * only, never written. A stand-in from a shell that did not answer (`LOGIN_ENV_FALLBACKS`) is never held as it.
   */
  let heldLogin: LaunchEnv | null = null;
  let listLoginTriedAt: number | null = null;
  let listLoginTry: Promise<void> | null = null;
  const holdLogin = (login: Readonly<LaunchEnv>) => {
    if (login.PATH && !LOGIN_ENV_FALLBACKS.has(login)) heldLogin = { ...login };
  };
  /** One login read for the lists, shared with any under way, at most every 5 minutes; null when none may start. */
  const listLogin = (): Promise<void> | null => {
    if (listLoginTry) return listLoginTry;
    if (listLoginTriedAt !== null && Date.now() - listLoginTriedAt < LIST_LOGIN_AGAIN_MS) return null;
    listLoginTriedAt = Date.now();
    listLoginTry = ctx
      .loginEnv()
      .then(holdLogin, () => {})
      .finally(() => {
        listLoginTry = null;
      });
    return listLoginTry;
  };
  type ListSource = { env: LaunchEnv; from: "held" | "names" | "plain" };
  /**
   * The env a list read starts from, and which it is (part of the cache key, so getting the full login env reads the
   * lists once again). A login env this host holds. Else, once a login read finished (it held nothing: the shell did
   * not answer), the Inbox's env with the login PATH and the names this host keeps, while one login read runs in the
   * background (never waited on here). Else, before any login read finished, one login read (shared with compose's
   * read ahead, which a Send waits on anyway), then the Inbox's env if it gave nothing to hold.
   */
  const listSource = async (): Promise<ListSource> => {
    if (heldLogin) return { env: heldLogin, from: "held" };
    const plain = (await ctx.environment()).env as LaunchEnv;
    const shell = ctx.shell();
    if (shell) {
      void listLogin();
      return { env: { ...plain, ...Object.fromEntries(OPENCODE_SHELL_NAMES.flatMap((name) => (shell[name] === undefined ? [] : [[name, shell[name]!]]))) }, from: "names" };
    }
    await listLogin();
    return heldLogin ? { env: heldLogin, from: "held" } : { env: plain, from: "plain" };
  };
  /** The source `choices` keyed its read on, so the read runs with the env its key came from. */
  let listFrom: LaunchEnv | null = null;
  const choiceLists = launchChoiceCache(async () => {
    const e = await ctx.environment();
    const path = binOf(e);
    if (!path) return openCodeUnread("missing");
    // Read with the login env, filtered (`openCodeListEnv`): the keys and OPENCODE_CONFIG it sets decide which
    // providers OpenCode lists.
    const env = openCodeListEnv(listFrom ?? (await listSource()).env);
    const read = (route: string) =>
      e
        .run([path, "--standalone", "api", "GET", route], { timeoutMs: LAUNCH_CHOICES_RUN_MS, cwd: ctx.homeDir, env, cleanEnv: true, outputCap: OPENCODE_LIST_OUTPUT_CAP })
        .catch(() => null);
    // The models, and OpenCode's own agents (build, plan, …) a session can start as: an agent list that can't be read
    // leaves no Agent column, never the models. The default's name is read apart (`defaultOf`): it never holds them.
    const [listed, agents] = await Promise.all([read("/api/model"), read("/api/agent")]);
    const failed = openCodeListFailure(listed);
    if (failed) return openCodeUnread(failed);
    let answer: unknown;
    try {
      answer = JSON.parse(listed!.stdout);
    } catch {
      return openCodeUnread("unreadable");
    }
    if (!Array.isArray((answer as { data?: unknown } | null)?.data)) return openCodeUnread("unreadable");
    const models = parseOpenCodeModels(answer);
    if (!models) return openCodeUnread("empty");
    const ok = (ran: AgentRunResult | null) => (ran && ran.exitCode === 0 && !ran.timedOut ? ran.stdout : null);
    const parsed = <T>(text: string | null, parse: (value: unknown) => T): T | null => {
      try {
        return text === null ? null : parse(JSON.parse(text));
      } catch {
        return null;
      }
    };
    const primary = parsed(ok(agents), parseOpenCodeAgents);
    return primary && primary.length > 0 ? { ...models, primary_agents: primary } : models;
  }, Date.now, { failedAgainMs: LIST_FAILED_AGAIN_MS, failedAgainMaxMs: LIST_FAILED_AGAIN_MAX_MS, binaryOf: (key) => key.slice(0, key.indexOf(LIST_KEY_CUT)) });

  /**
   * OpenCode's own default (`GET /api/model/default`), read in the HOME folder only, exactly as the lists are (same env,
   * same 5 s, same binary): never in a project, whose config and plugins OpenCode would load (a project's own `model`
   * is read as data, `openCodeProjectModel`). One per list key: a new key (a config or sign-in change) reads it again.
   * Never waited on: undefined while it reads, null after a read that failed, which is tried again after the list's
   * backoff (15 s, doubled up to 5 minutes; a new key starts over).
   */
  let homeDefault: { key: string; model: string | null; reading: boolean; at: number; times: number } | null = null;
  const homeDefaultOf = (listKey: string): string | null | undefined => {
    const kept = homeDefault?.key === listKey ? homeDefault : null;
    if (kept?.reading) return undefined;
    if (kept?.model) return kept.model;
    if (kept && Date.now() - kept.at < Math.min(LIST_FAILED_AGAIN_MAX_MS, LIST_FAILED_AGAIN_MS * 2 ** (kept.times - 1))) return null;
    const entry = { key: listKey, model: null as string | null, reading: true, at: 0, times: kept?.times ?? 0 };
    homeDefault = entry;
    void (async () => {
      try {
        const e = await ctx.environment();
        const path = binOf(e);
        if (!path) return;
        const env = openCodeListEnv(listFrom ?? (await listSource()).env);
        const ran = await e.run([path, "--standalone", "api", "GET", "/api/model/default"], { timeoutMs: LAUNCH_CHOICES_RUN_MS, cwd: ctx.homeDir, env, cleanEnv: true });
        if (ran.exitCode === 0 && !ran.timedOut) entry.model = parseOpenCodeDefaultModel(JSON.parse(ran.stdout));
      } catch {
        entry.model = null;
      } finally {
        entry.reading = false;
        entry.at = Date.now();
        entry.times = entry.model ? 0 : entry.times + 1;
      }
    })();
    return undefined;
  };

  return {
    agent: OPENCODE,
    name: OPENCODE_NAME,
    shellNames: OPENCODE_SHELL_NAMES,

    async available(): Promise<LaunchAvailability> {
      const e = await ctx.environment();
      const path = binOf(e);
      if (!path) return { ok: false, missing: true, reason: "opencode2 is not on the Inbox's PATH", code: "missing" };
      if (!openCodePluginInstalled(e)) return { ok: false, missing: false, reason: "Plannotator's OpenCode plugin is not installed (opencode2 plugin add @plannotator/opencode)", code: "plugin_off" };
      const version = parseOpenCodeVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
      if (!version || !versionAtLeast(version, OPENCODE_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `OpenCode ${version ?? "?"} is older than ${OPENCODE_LAUNCH_MIN_VERSION}`, code: "too_old" };
      const plugin = installedOpenCodePlugin(cacheHome());
      if (plugin && !plugin.launches) return { ok: false, missing: false, reason: `Plannotator's OpenCode plugin ${plugin.version} can't start sessions from the Inbox; update it (${OPENCODE_PLUGIN_UPDATE})`, code: "too_old" };
      binName = basename(path);
      choiceKey = `${path}@${version}`;
      return { ok: true, version };
    },

    /** Every login read the Inbox makes: held for the list reads (not a shell that did not answer). */
    loginRead: holdLogin,
    choicesWhileReading: OPENCODE_CHOICES_READING,

    // The key: the binary (path@version), which env the read starts from, and OpenCode's config and sign-in files'
    // stamps, found with that same env. A provider added or signed in to shows on the next read, with no Inbox restart.
    // `defaultIn`: the folder To names (null: the home folder, as for a scratch folder not made yet); absent, no
    // default is named. A project's own `model` is read from its config files as data (nothing of it runs); else, or
    // for the home folder, OpenCode's default read in the home folder, beside the list's and never waited on.
    async choices(options: { defaultIn?: string | null } = {}) {
      if (choiceKey === null) return choiceLists(null);
      const key = choiceKey;
      const source = await listSource();
      listFrom = source.env;
      const listKey = [key, source.from, openCodeListStamp(createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env: source.env }))].join(LIST_KEY_CUT);
      const own = typeof options.defaultIn === "string" ? openCodeProjectModel(options.defaultIn, ctx.homeDir, { configContent: !!source.env.OPENCODE_CONFIG_CONTENT?.trim() }) : null;
      const fromHome = options.defaultIn === null || own?.kind === "none";
      if (fromHome) homeDefaultOf(listKey);
      const lists = await choiceLists(listKey);
      if (!lists || lists.unread || options.defaultIn === undefined) return lists;
      const model = own?.kind === "model" ? own.model : fromHome ? homeDefaultOf(listKey) : null;
      return model ? { ...lists, default_model: model } : lists;
    },

    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      holdLogin(input.login);
      const made = await makeSession(launch, input);
      if (!made.ok) return made;
      procs.set(made.session, made.server);
      return { ok: true as const, session: made.session, ref: made.session };
    },

    /**
     * Start in Rex: OpenCode's session is made as for `start` (its id exists only once a server makes it), that
     * server ends, and the tab runs OpenCode's own terminal UI on it, as Open in Terminal does. The plugin there
     * connects as that session at its start and takes the root as its first turn. `resume`: the same session again
     * (`fresh` changes nothing: the session exists from `makeSession` whether or not it took a turn).
     */
    async rexCommand(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv; resume: boolean; fresh?: boolean }) {
      holdLogin(input.login);
      let session = input.resume ? (launch.session_ref ?? "") : "";
      if (!session) {
        const made = await makeSession(launch, input);
        if (!made.ok) return made;
        await end(made.server, "close");
        session = made.session;
      }
      // Its name as found now (an Inbox just restarted has not checked it yet: `opencode2`, or OpenCode 2 as `opencode`).
      const found = binOf(await ctx.environment());
      if (found) binName = basename(found);
      const command = `cd ${shellQuote(launch.folder)} && exec env ${openCodeTerminalRun(binName, session, dataDirArg())}`;
      ctx.startLog(launch.id, `rex: ${command}`);
      return { ok: true as const, session, ref: session, command };
    },

    async sessions() {
      return (ref: string) => {
        const s = procs.get(ref);
        if (!s) return "absent" as const;
        return s.exited ? { status: null, state: "stopped", waitingFor: null } : { status: s.busySince !== null ? "busy" : "idle", state: "running", waitingFor: null };
      };
    },

    live(session: string): LaunchLive | null {
      const polled = ctx.bridge.runStateOf(session);
      const s = running(session);
      if (!polled || !s) return polled;
      return { ...polled, busy: s.busySince !== null, busySince: s.busySince };
    },

    async resume(launch: InboxLaunchRecord): Promise<ResumeResult> {
      const session = launch.session_ref!;
      if (spawning.has(session)) return nothing("starting already");
      const old = running(session);
      if (old && ctx.bridge.runStateOf(session)) return nothing("already running here");
      let finish!: () => void;
      const mark: Spawning = { cancel: null, done: new Promise<void>((done) => (finish = done)) };
      spawning.set(session, mark);
      try {
        if (old) await end(old, "restart");
        const login = await ctx.loginEnv().catch((): LaunchEnv => ({}));
        holdLogin(login);
        if (mark.cancel) return nothing("cancelled during the restart: nothing started");
        const result = await spawnServer(launch, session, login, () => mark.cancel !== null);
        if (mark.cancel) {
          const s = running(session);
          if (s) await end(s, mark.cancel);
          return nothing(`cancelled during the restart: ${s ? "ended as it came up" : "nothing started"}`);
        }
        if (!result.ok) return { exitCode: 1, text: result.output, failure: { code: "failed", text: result.text } };
        return nothing(`opencode serve, session ${session}: ready`);
      } finally {
        spawning.delete(session);
        finish();
      }
    },

    async stop(ref: string): Promise<LaunchHostResult> {
      const mark = spawning.get(ref);
      if (mark) mark.cancel = "stop";
      const s = running(ref);
      const code = s ? await end(s, "stop") : null;
      if (mark) {
        await mark.done;
        return { exitCode: 0, text: "stopped during a restart: nothing left running" };
      }
      if (!s) return { exitCode: 0, text: "not running in this Inbox" };
      return { exitCode: code ?? 1, text: code === null ? "did not end; killed" : `ended ${code}` };
    },
    remove: async (): Promise<LaunchHostResult> => ({ exitCode: 0, text: "OpenCode keeps its own sessions" }),
    purge: async (): Promise<LaunchHostResult & { skipped?: string }> => ({ exitCode: 0, text: "", skipped: "OpenCode keeps its sessions in its own database" }),

    attach(launch: InboxLaunchRecord): string | null {
      const session = launch.session_ref;
      if (!session || running(session) || spawning.has(session)) return null;
      return openCodeAttachCommand(binName, launch.folder, session, dataDirArg());
    },
    terminal(launch: InboxLaunchRecord): string {
      const session = launch.session_ref;
      if (!session) return `cd ${shellQuote(launch.folder)} && ${binName}`;
      const mark = spawning.get(session);
      if (mark && mark.cancel === null) mark.cancel = "handoff";
      const s = running(session);
      if (!s) return openCodeAttachCommand(binName, launch.folder, session, dataDirArg());
      void end(s, "handoff");
      return openCodeHandoffCommand(binName, launch.folder, session, s.proc.pid, dataDirArg());
    },

    processEnded(ref: string): boolean {
      return !running(ref) && !spawning.has(ref);
    },

    permissions(context: LaunchPermissionContext) {
      threads = context;
      permissions = createOpenCodePermissions({
        ...context,
        log: context.log ?? ctx.log,
        respond: async (target, requestID, decision) => {
          const s = target as OpenCodeServer;
          if (s.exited || !s.session) return false;
          const answer = await call(s, "POST", `/api/session/${s.session}/permission/${encodeURIComponent(requestID)}/reply`, { decision }).catch(() => null);
          return !!answer?.ok;
        },
        tell: (target, text) => {
          const s = target as OpenCodeServer;
          if (!s.exited && s.session) void call(s, "POST", `/api/session/${s.session}/prompt`, { text }).catch(() => undefined);
        },
      });
      return permissions;
    },

    stoppedNote(launch: InboxLaunchRecord): string | null {
      const session = launch.session_ref;
      if (!session) return null;
      const s = procs.get(session);
      if (s?.exited && s.ending === null) return `OpenCode ended on its own (exit ${s.exitCode ?? "unknown"}). Your reply continues it.`;
      if (s?.exited && s.ending === "handoff") return "It was opened in Terminal. Your reply continues it here once OpenCode there has quit.";
      return OPENCODE_STOPPED_NOTE;
    },

    close() {
      for (const mark of spawning.values()) mark.cancel = "stop";
      for (const s of new Set([...procs.values(), ...serving])) {
        if (s.exited) continue;
        s.ending ??= "close";
        s.proc.kill("SIGTERM");
        const timer = setTimeout(() => {
          if (!s.exited) s.proc.kill("SIGKILL");
        }, 2_000);
        (timer as { unref?: () => void }).unref?.();
      }
    },
  } satisfies LaunchHost;
}
