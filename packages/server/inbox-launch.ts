/**
 * Launch agents from the Inbox, PR 1 (PLAN `.ops/work/launch-plan/PLAN.md`):
 * the person picks "New Claude Code session" in compose's To, writes and
 * sends; Claude Code starts in the project with the person's own setup, and
 * the thread is an ordinary thread with one quiet run line.
 *
 * We start nothing that lives on its own: Claude's own supervisor hosts the
 * session (`claude --bg`, inbox-launch-claude.ts). Messages move over the
 * mod's existing bridge poll. Behind `inboxLaunch.enabled` (config only,
 * default off): off, every route here answers 404 and nothing else changes.
 *
 * The flow (compose's Send, packages/server/inbox-compose.ts):
 *  1. `prepare`: the project's folder must be there (422 folder_missing) and
 *     the agent available (409 agent_unavailable). Nothing is written.
 *  2. Compose writes the thread addressed to a placeholder
 *     `{ claude-code, launch:<id> }` with `launch` on the root. No poll can
 *     claim a placeholder, and a replayed key never starts a second agent.
 *  3. `begin`: the settings file, then `claude --bg` in the background; the
 *     answer comes at once. The host's id moves the root to the real session
 *     (`store.settleLaunch`), whose mod then takes it as its first turn
 *     through the existing new-thread wake. A failed start sets
 *     `launch.error`.
 *
 * The run line is computed on read (`inboxRunOf`, packages/core/inbox-run-line.ts)
 * from the launch record, the mod's poll, and `claude agents --json --all`,
 * read only while something needs it, at most every 10 s. A person's reply
 * to a launched session that is not live respawns it (`claude respawn`).
 *
 * Window routes (same origin and `serverSession`; never over the tailnet for
 * Open and the settings):
 *   POST /api/inbox/launch/:id/stop      claude stop
 *   POST /api/inbox/launch/:id/open      Terminal: `claude attach` (or plain `claude` in an untrusted folder); macOS
 *   POST /api/inbox/launch/:id/delete    stop, rm, and the launch folder; the thread stays
 *   POST /api/inbox/launch/:id/retry     Try again after a failed start
 *   POST /api/inbox/launch/settings      `{ full_permissions }` (Settings → Agents)
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { INBOX_HOST_NAMES, inboxId, type InboxComposeLaunch, type InboxLaunchAgent, type InboxLaunchRecord, type InboxListRow, type InboxMessage, type InboxProject, type InboxRun } from "@plannotator/core/inbox-types";
import { inboxRunOf, INBOX_RUN_START_GRACE_MS, type InboxRunHostState } from "@plannotator/core/inbox-run-line";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { loadConfig, resolveInboxLaunch, saveConfig } from "@plannotator/shared/config";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { INBOX_TOOL_NAME } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { agentVersionRun, claudeCodeInboxToolOn, claudeCodePluginEnabled, createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { claudeAttachCommand, claudeTrustCommand, CLAUDE_LAUNCH_MIN_VERSION, createClaudeHost, parseClaudeVersion, versionAtLeast, type ClaudeAgent, type ClaudeHost } from "./inbox-launch-claude";
import { launchSettingsEnv, launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";

const HOST = "claude-code";
const AGENT_NAME = INBOX_HOST_NAMES[HOST] ?? "Claude Code";
/** The agent's own Inbox call never prompts, whatever the person's permission mode. */
const INBOX_TOOL_PERMISSION = `mcp__plannotator__${INBOX_TOOL_NAME}`;
const AVAILABLE_TTL_MS = 30_000;
const HOST_TTL_MS = 10_000;

type Availability = { ok: true; version: string } | { ok: false; missing: boolean; reason: string };

/** What the Inbox remembers about a launch while it runs (never stored: a restart forgets it, and the line still reads right). */
interface Memo {
  startedAt: number;
  again: boolean;
  stoppedAt: number | null;
  waitingSince: number | null;
  /**
   * After Stop or a respawn, the session's earlier polls keep it "live" for a
   * while: it counts as live again only once it starts a poll past this count.
   */
  quietPolls: number | null;
}

export function createInboxLaunch(options: {
  store: InboxStore;
  live: { runStateOf(session: string): { busy: boolean | null; busySince: number | null; polls: number } | null };
  dataDir: string;
  serverSession: string;
  homeDir: string;
  platform: NodeJS.Platform;
  /** The person's login-shell env (inbox-launch-env.ts `createLoginEnv`). */
  loginEnv: () => Promise<LaunchEnv>;
  displayFolder: (path: string) => string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** The windows should read the list and open thread again (a start settled, a stop). */
  onChange: () => void;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const { store, json } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const config = () => resolveInboxLaunch(loadConfig());
  const enabled = () => config().enabled;

  const environment = async (): Promise<AgentEnvironment> =>
    createAgentEnvironmentFor({ platform: options.platform, homeDir: options.homeDir, env: launchSpawnEnv(await options.loginEnv()) });
  const host: ClaudeHost = createClaudeHost({ environment });

  // ── Availability: `claude` on the login PATH, new enough, the plugin's mod and its Inbox tool on ──
  let availability: { at: number; value: Promise<Availability> } | null = null;
  const checkAvailable = async (): Promise<Availability> => {
    const e = await environment();
    const path = e.which("claude");
    if (!path) return { ok: false, missing: true, reason: "claude is not on your login shell's PATH" };
    const version = parseClaudeVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
    if (!version || !versionAtLeast(version, CLAUDE_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `Claude Code ${version ?? "?"} is older than ${CLAUDE_LAUNCH_MIN_VERSION}` };
    if (!claudeCodePluginEnabled(e) || !claudeCodeInboxToolOn(e)) return { ok: false, missing: false, reason: "Plannotator's Claude Code plugin or its Inbox tool is off" };
    return { ok: true, version };
  };
  const available = (fresh = false): Promise<Availability> => {
    if (!availability || fresh || now() - availability.at > AVAILABLE_TTL_MS) availability = { at: now(), value: checkAvailable().catch(() => ({ ok: false, missing: false, reason: "could not check" }) as Availability) };
    return availability.value;
  };
  /** The last answer, without waiting (null before the first). */
  let lastAvailable: Availability | null = null;
  const refreshAvailable = () => void available().then((value) => (lastAvailable = value));

  // ── The host's view: one `claude agents --json --all`, shared, at most every 10 s, only while something needs it ──
  let hostView: { at: number; agents: ClaudeAgent[] | null } | null = null;
  let hostFetch: Promise<void> | null = null;
  const refreshHost = (): Promise<void> => {
    if (hostFetch) return hostFetch;
    hostFetch = host
      .agents()
      .then((agents) => {
        hostView = { at: now(), agents };
      })
      .catch(() => {
        hostView = { at: now(), agents: null };
      })
      .finally(() => {
        hostFetch = null;
        options.onChange();
      });
    return hostFetch;
  };
  const hostStale = () => !hostView || now() - hostView.at > HOST_TTL_MS;
  const hostStateOf = (ref: string | null): InboxRunHostState | null => {
    if (!ref || !hostView?.agents) return null;
    const agent = hostView.agents.find((a) => a.id === ref || a.sessionId.startsWith(ref));
    return agent ? { status: agent.status, state: agent.state, waitingFor: agent.waitingFor } : "absent";
  };

  const memos = new Map<string, Memo>();
  const memoOf = (launch: InboxLaunchRecord): Memo => {
    let memo = memos.get(launch.id);
    if (!memo) {
      memo = { startedAt: Date.parse(launch.started_at), again: false, stoppedAt: null, waitingSince: null, quietPolls: null };
      memos.set(launch.id, memo);
    }
    return memo;
  };

  const launchDir = (id: string) => join(store.dir, "launch", id);
  const startLog = (id: string, text: string) => {
    try {
      mkdirSync(launchDir(id), { recursive: true, mode: 0o700 });
      appendFileSync(join(launchDir(id), "start.log"), `── ${new Date(now()).toISOString()}\n${text.trimEnd()}\n`, { mode: 0o600 });
    } catch {
      // Best effort: the log is for the person reading it by hand.
    }
  };

  /** The live poll of a launched root's session, with Stop counted at once. */
  const liveOf = (root: InboxMessage, memo: Memo) => {
    const session = root.to?.session;
    if (!session || session.startsWith("launch:")) return null;
    const state = options.live.runStateOf(session);
    if (state && memo.quietPolls !== null) {
      if (state.polls <= memo.quietPolls) return null;
      // It polled since: started again (a respawn, or by hand in a terminal).
      memo.quietPolls = null;
      memo.stoppedAt = null;
    }
    return state;
  };

  /** The run line of a launched root; `fetch` lets the caller wait for a fresh host read when one is due. */
  const runOfRoot = (root: InboxMessage): InboxRun | null => {
    const launch = root.launch!;
    if (launch.deleted_at) return null;
    const memo = memoOf(launch);
    const live = liveOf(root, memo);
    const hostState = hostStateOf(launch.session_ref);
    if (hostState && hostState !== "absent" && hostState.status === "waiting" && hostState.waitingFor) memo.waitingSince ??= now();
    else memo.waitingSince = null;
    const project = store.project(root.project_id)?.name ?? launch.folder;
    return inboxRunOf({
      launch,
      project,
      now: now(),
      startedAt: memo.startedAt,
      again: memo.again,
      cliAvailable: lastAvailable === null ? null : !(lastAvailable.ok === false && lastAvailable.missing),
      live,
      turnWaiting: !root.delivery || (!!root.to && store.pendingReplies(root.to.session, { tags: true }).length > 0),
      seenLive: !!root.delivery,
      host: hostState,
      waitingSince: memo.waitingSince,
      stoppedByPersonAt: memo.stoppedAt,
      attachCommand: launch.session_ref ? claudeAttachCommand(launch.folder, launch.session_ref) : null,
    });
  };

  /** Whether the host's view could change this root's line: a turn runs (a prompt may block it), or it is not live past the start. */
  const needsHost = (root: InboxMessage): boolean => {
    const launch = root.launch!;
    if (launch.deleted_at || launch.error || !launch.session_ref) return false;
    const memo = memoOf(launch);
    const live = liveOf(root, memo);
    if (live) return live.busy === true;
    if (now() - memo.startedAt < INBOX_RUN_START_GRACE_MS) return false;
    const state = hostStateOf(launch.session_ref);
    return !(state === "absent" || (state && (state.state === "stopped" || state.state === "done")));
  };

  const roots = () => store.launchedRoots();
  const rootById = (launchId: string): InboxMessage => {
    const root = roots().find((m) => m.launch!.id === launchId);
    if (!root) throw new InboxError("launch_not_found", `No launch ${launchId}.`);
    return root;
  };

  /** Look at every launch: ask the host when a line could change, respawn a stopped session someone wrote to. */
  const sweep = () => {
    if (!enabled()) return;
    const all = roots().filter((root) => !root.launch!.deleted_at);
    if (all.length === 0) return;
    if (lastAvailable === null || (availability && now() - availability.at > AVAILABLE_TTL_MS)) refreshAvailable();
    if (hostStale() && all.some(needsHost)) void refreshHost();
    for (const root of all) maybeRespawn(root);
  };

  // ── Start ──

  const writeSettings = (launch: InboxLaunchRecord, login: LaunchEnv, fullPermissions: boolean): string => {
    const dir = launchDir(launch.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "settings.json");
    const extra = config().extraSettings;
    const extraEnv = extra.env && typeof extra.env === "object" ? (extra.env as Record<string, string>) : {};
    const extraPermissions = extra.permissions && typeof extra.permissions === "object" ? (extra.permissions as Record<string, unknown>) : {};
    const allow = Array.isArray(extraPermissions.allow) ? extraPermissions.allow : [];
    const isDefaultDataDir = resolve(options.dataDir) === resolve(getDefaultPlannotatorDataDir(options.homeDir));
    const settings = {
      ...extra,
      env: { ...extraEnv, ...launchSettingsEnv(login, { launchId: launch.id, key: randomBytes(32).toString("hex"), dataDir: isDefaultDataDir ? null : options.dataDir, fullPermissions }) },
      permissions: { ...extraPermissions, allow: [...new Set([...allow, INBOX_TOOL_PERMISSION])] },
    };
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };

  /** Start (or start again) the agent for a launched root, in the background. */
  const run = async (root: InboxMessage, again: boolean): Promise<void> => {
    const launch = root.launch!;
    const memo = memoOf(launch);
    memo.startedAt = now();
    memo.again = again;
    memo.stoppedAt = null;
    try {
      const login = await options.loginEnv();
      const fullPermissions = config().fullPermissions;
      const settingsPath = writeSettings(launch, login, fullPermissions);
      const name = root.thread_name ?? root.subject ?? "Inbox";
      const result = await host.start({ folder: launch.folder, shownFolder: options.displayFolder(launch.folder), name, settingsPath, fullPermissions });
      startLog(launch.id, result.output);
      if (result.ok) store.settleLaunch(root.id, { to: { host: HOST, session: result.session }, session_ref: result.short });
      else store.settleLaunch(root.id, { error: { code: result.missing ? "missing" : result.code, text: result.text, at: new Date(now()).toISOString() } });
      log(`Inbox launch ${launch.id}: ${result.ok ? `started ${result.short}` : `did not start (${result.code})`}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      startLog(launch.id, `error: ${text}`);
      store.settleLaunch(root.id, { error: { code: "failed", text, at: new Date(now()).toISOString() } });
    } finally {
      hostView = null;
      options.onChange();
    }
  };

  // ── Respawn on reply: a person's message for a launched session that is not live ──
  const respawning = new Set<string>();
  const maybeRespawn = (root: InboxMessage) => {
    const launch = root.launch!;
    // Only a session that connected once: one that never did is "not connected", and respawning it would not help.
    if (launch.deleted_at || launch.error || !launch.session_ref || !root.to || !root.delivery || respawning.has(launch.id)) return;
    const memo = memoOf(launch);
    if (liveOf(root, memo)) return;
    if (now() - memo.startedAt < INBOX_RUN_START_GRACE_MS) return;
    if (store.pendingReplies(root.to.session, { tags: true }).length === 0) return;
    respawning.add(launch.id);
    memo.startedAt = now();
    memo.again = true;
    memo.stoppedAt = null;
    memo.quietPolls = options.live.runStateOf(root.to.session)?.polls ?? memo.quietPolls;
    options.onChange();
    void host
      .respawn(launch.session_ref)
      .then(async (result) => {
        startLog(launch.id, `respawn ${launch.session_ref}: exit ${result.exitCode}\n${result.stdout}${result.stderr}`);
        // It did not start again: look at the CLI at once, so a Claude Code that is gone says so (screen 15).
        if (result.exitCode !== 0) lastAvailable = await available(true);
      })
      .finally(() => {
        options.onChange();
        respawning.delete(launch.id);
        hostView = null;
      });
  };
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message" || !enabled()) return;
    const message = line.record;
    if (message.author.kind !== "person" || message.id === message.thread_id || message.delivery) return;
    const root = store.message(message.thread_id);
    if (root?.launch) queueMicrotask(() => maybeRespawn(store.message(root.id) ?? root));
  });

  // ── Routes ──

  const settingsState = () => ({ enabled: enabled(), full_permissions: config().fullPermissions });

  const route = async (req: Request, path: string, via: "local" | "tailnet" | string): Promise<Response | null> => {
    const match = /^\/api\/inbox\/launch\/(settings|lch_[0-9A-HJKMNP-TV-Z]{26})(?:\/(stop|open|delete|retry))?$/.exec(path);
    if (!match) return null;
    if (!enabled()) return json({ error: "Launch is off.", code: "launch_off" }, 404);
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const localOnly = () => json({ error: "Only from this computer.", code: "owner_only" }, 403);
    if (match[1] === "settings") {
      if (match[2]) return null;
      if (via === "tailnet") return localOnly();
      if (typeof body.full_permissions !== "boolean") throw new InboxError("validation_error", "full_permissions: a boolean.", { field: "full_permissions" });
      const current = loadConfig().inboxLaunch ?? {};
      saveConfig({ inboxLaunch: { ...current, fullPermissions: body.full_permissions } });
      if (config().fullPermissions !== body.full_permissions) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed.");
      return json({ launch: settingsState() });
    }
    const root = rootById(match[1]!);
    const launch = root.launch!;
    switch (match[2]) {
      case "stop": {
        if (!launch.session_ref) throw new InboxError("launch_not_found", "That session never started.");
        const memo = memoOf(launch);
        const result = await host.stop(launch.session_ref);
        startLog(launch.id, `stop ${launch.session_ref}: exit ${result.exitCode}\n${result.stdout}${result.stderr}`);
        memo.stoppedAt = now();
        memo.startedAt = Math.min(memo.startedAt, now() - INBOX_RUN_START_GRACE_MS);
        // Its last polls still read as live for a while: from now it counts as live only once it polls anew.
        if (root.to) memo.quietPolls = options.live.runStateOf(root.to.session)?.polls ?? memo.quietPolls;
        hostView = null;
        options.onChange();
        return json({ run: runOfRoot(store.message(root.id)!) });
      }
      case "open": {
        if (via === "tailnet") return localOnly();
        if (options.platform !== "darwin") throw new InboxError("open_unavailable", "Open in Terminal is for macOS; copy the command instead.");
        const command = launch.session_ref && !launch.error ? claudeAttachCommand(launch.folder, launch.session_ref) : claudeTrustCommand(launch.folder);
        const e = await environment();
        const osascript = e.which("osascript");
        if (!osascript) throw new InboxError("open_unavailable", "osascript is not on PATH; copy the command instead.");
        // `on run argv`: the command is an argument, never part of the script's text.
        const script = ["on run argv", 'tell application "Terminal"', "activate", "do script (item 1 of argv)", "end tell", "end run"];
        const result = await e.run([osascript, ...script.flatMap((line) => ["-e", line]), command], { timeoutMs: 15_000 });
        if (result.exitCode !== 0) throw new InboxError("open_unavailable", `Terminal did not open: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
        return json({ ok: true, command });
      }
      case "delete": {
        if (launch.session_ref) {
          const stop = await host.stop(launch.session_ref);
          const rm = await host.rm(launch.session_ref);
          log(`Inbox launch ${launch.id}: deleted (stop ${stop.exitCode}, rm ${rm.exitCode})`);
        }
        // Never `claude purge` here: it clears every session of the folder, and this is the person's project.
        rmSync(launchDir(launch.id), { recursive: true, force: true });
        store.settleLaunch(root.id, { deleted_at: new Date(now()).toISOString() });
        memos.delete(launch.id);
        options.onChange();
        return json({ ok: true });
      }
      case "retry": {
        if (!launch.error) throw new InboxError("validation_error", "That launch did not fail.");
        if (!isFolder(launch.folder)) throw new InboxError("folder_missing", `${options.displayFolder(launch.folder)} isn't there any more.`);
        const cleared = store.settleLaunch(root.id, { error: null });
        void run(cleared, true);
        return json({ run: runOfRoot(cleared) });
      }
    }
    return null;
  };

  const isFolder = (path: string) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };

  return {
    enabled,
    settingsState,
    route,
    sweep,
    stop: () => unsubscribe(),

    /** Compose's `to.launch`, when launch is on: `{ agent, project_id }`; null for any other `to`. */
    target(to: unknown): { agent: InboxLaunchAgent; project_id: string } | null {
      if (!to || typeof to !== "object" || !("launch" in to)) return null;
      if (!enabled()) throw new InboxError("launch_off", "Starting agents from the Inbox is off.");
      const value = (to as { launch: unknown }).launch as Record<string, unknown> | null;
      if (!value || typeof value !== "object" || value.agent !== HOST || typeof value.project_id !== "string") {
        throw new InboxError("validation_error", "to.launch: { agent: \"claude-code\", project_id }.", { field: "to.launch" });
      }
      return { agent: HOST, project_id: value.project_id };
    },

    /** Check before anything is written: the folder is there and the agent can start. */
    async prepare(target: { agent: InboxLaunchAgent; project_id: string }): Promise<{ project: InboxProject; to: { host: string; session: string }; launch: InboxLaunchRecord }> {
      const project = store.project(target.project_id);
      if (!project) throw new InboxError("project_not_found", `No project ${target.project_id}.`);
      if (!isFolder(project.root)) {
        throw new InboxError("folder_missing", `${options.displayFolder(project.root)} isn't there any more. Pick another project. Nothing was sent.`, { field: "to.launch" });
      }
      const ok = await available(true);
      lastAvailable = ok;
      if (!ok.ok) throw new InboxError("agent_unavailable", `${AGENT_NAME} can't be started here: ${ok.reason}. Nothing was sent.`);
      const id = inboxId("lch");
      const launch: InboxLaunchRecord = { id, agent: HOST, session_ref: null, folder: project.root, scratch: false, started_at: new Date(now()).toISOString(), ...(config().fullPermissions ? { full_permissions: true } : {}) };
      return { project, to: { host: HOST, session: `launch:${id}` }, launch };
    },

    /** The thread is written: start the agent in the background. */
    begin(root: InboxMessage): void {
      void run(root, false);
    },

    /** `GET /api/inbox/sessions`'s `launch` block: the agents To offers, the projects the folder menu lists. */
    async composeBlock(): Promise<InboxComposeLaunch | undefined> {
      if (!enabled()) return undefined;
      // Not available last time: look again (the person may have just installed or updated it).
      const ok = await available(lastAvailable !== null && !lastAvailable.ok);
      lastAvailable = ok;
      const recency = new Map<string, string>();
      for (const row of store.listRows()) if ((recency.get(row.project.id) ?? "") < row.last_at) recency.set(row.project.id, row.last_at);
      const projects = store
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, root: p.root, exists: isFolder(p.root) }))
        .sort((a, b) => (recency.get(b.id) ?? "").localeCompare(recency.get(a.id) ?? "") || a.name.localeCompare(b.name));
      return { agents: ok.ok ? [{ agent: HOST, name: AGENT_NAME }] : [], projects };
    },

    /** The thread route's `run`: waits for a host read when one is due. */
    async runOf(threadId: string): Promise<InboxRun | null | undefined> {
      if (!enabled()) return undefined;
      const root = store.message(threadId);
      if (!root?.launch || root.thread_id !== root.id) return undefined;
      if (lastAvailable === null) lastAvailable = await available();
      if (hostStale() && needsHost(root)) await refreshHost();
      return runOfRoot(store.message(threadId)!);
    },

    /** A list row with its run word, and a session blocked on a prompt placed in Stopped on you. */
    decorateRow<T extends InboxListRow>(row: T): T {
      if (!enabled()) return row;
      const root = store.message(row.thread_id);
      if (!root?.launch) return row;
      const runLine = runOfRoot(root);
      if (runLine?.state === "waiting_terminal" && row.resolved_at === null) return { ...row, section: "stopped", unread: true, run: null };
      const word = runLine?.state === "starting" || runLine?.state === "working" ? runLine.state : null;
      // The person's item waits on the start, not on a session that ended: the row says "Starting", no tick.
      // A start that failed, or an agent that is gone, uses the existing "not delivered" tick (screens 14, 15).
      const pending = row.delivery && row.delivery.state !== "delivered" ? row.delivery : null;
      const delivery = !pending
        ? row.delivery
        : word
          ? null
          : runLine?.state === "failed" || runLine?.state === "missing"
            ? { ...pending, state: "undelivered" as const, reason: "undelivered" as const, send_now: false }
            : row.delivery;
      return { ...row, run: word, delivery };
    },

    /** Changes when any launched thread's line would: part of the windows' delivery signature. */
    signature(): string {
      if (!enabled()) return "";
      return roots()
        .map((root) => {
          const line = runOfRoot(root);
          return `${root.launch!.id}:${line ? `${line.state}${line.again ? "+" : ""}${line.since ?? ""}` : "-"}`;
        })
        .join(",");
    },
  };
}

export type InboxLaunch = ReturnType<typeof createInboxLaunch>;
