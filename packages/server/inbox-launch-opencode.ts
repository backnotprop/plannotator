import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { openCodeSessionModel, parseOpenCodeModels } from "@plannotator/core/inbox-launch-choice";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { OPENCODE_LAUNCH_ENV, OPENCODE_LAUNCH_SESSION_ENV, openCodeSessionIdOk } from "@plannotator/shared/inbox/opencode-launch";
import { agentVersionRun, openCodeGeneration, openCodePluginInstalled, type AgentEnvironment } from "./inbox-agents";
import { LAUNCH_CHOICES_RUN_MS, launchChoiceCache } from "./inbox-launch-choice";
import { shellQuote, versionAtLeast } from "./inbox-launch-claude";
import { launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import { launchNoteText, writeLaunchNote, type LaunchAvailability, type LaunchHost, type LaunchHostContext, type LaunchHostResult, type LaunchLive, type LaunchPermissionContext } from "./inbox-launch-host";
import { createOpenCodePermissions, OPENCODE, OPENCODE_NAME, type OpenCodePermissionAsked } from "./inbox-launch-opencode-permission";

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
        const text = String(data.error?.message ?? data.error ?? data.message ?? "");
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
      proc = Bun.spawn([path, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: launch.folder, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
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

  let binName = "opencode2";
  let choiceKey: string | null = null;
  const choiceLists = launchChoiceCache(async () => {
    const e = await ctx.environment();
    const path = binOf(e);
    if (!path) return null;
    const listed = await e.run([path, "--standalone", "api", "GET", "/api/model"], { timeoutMs: LAUNCH_CHOICES_RUN_MS, cwd: ctx.homeDir });
    if (listed.exitCode !== 0 || listed.timedOut) return null;
    try {
      return parseOpenCodeModels(JSON.parse(listed.stdout));
    } catch {
      return null;
    }
  });

  return {
    agent: OPENCODE,
    name: OPENCODE_NAME,
    shellNames: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR"],

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

    choices: () => choiceLists(choiceKey),

    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
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
      const created = await json<{ data?: { id?: unknown } }>(s, "POST", "/api/session", { location: { directory: launch.folder }, title: input.name.trim() || "Inbox", ...(model ? { model } : {}) }).catch((error: unknown) => {
        ctx.startLog(launch.id, `POST /api/session: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      const session = created?.data?.id;
      if (!openCodeSessionIdOk(session)) return failed("OpenCode did not make a session");
      s.session = session;
      procs.set(session, s);
      ctx.startLog(launch.id, `session ${session}${model ? ` on ${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : ""}`);
      return { ok: true as const, session, ref: session };
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
      for (const s of procs.values()) {
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
