/**
 * Launch agents from the Inbox, PR 1 (PLAN `.ops/work/launch-plan/PLAN.md`):
 * the person picks "New Claude Code session" in compose's To, writes and
 * sends; the agent starts in the project with the person's own setup, and
 * the thread is an ordinary thread with one quiet run line.
 *
 * This file is the engine, the same for every agent. What one agent does
 * (its CLI, its settings, trust, how it connects, its permission transport)
 * is its `LaunchHost` (inbox-launch-host.ts), held in `hosts` by the agent's
 * id: `claude-code` is inbox-launch-claude.ts. A record whose agent has no
 * host here (a downgrade) gets no line, no sweep and `404 launch_not_found`.
 *
 * We start nothing that lives on its own: the agent's own background host
 * keeps the session (`claude --bg`). Messages move over the links the Inbox
 * already has (Claude Code: the mod's bridge poll). Behind
 * `inboxLaunch.enabled` (config only, default off): off, every route here
 * answers 404 and nothing else changes.
 *
 * The flow (compose's Send, packages/server/inbox-compose.ts):
 *  1. `prepare`: the project's folder must be there (422 folder_missing) and
 *     the agent available (409 agent_unavailable). Nothing is written. A
 *     scratch launch (PR 3) then makes `<scratch root>/<thread-name slug>`
 *     (`-2`, `-3` when taken, never through a link); Delete purges and
 *     removes that folder, and only while it is still the one it made.
 *  2. Compose writes the thread addressed to a placeholder
 *     `{ <agent>, launch:<id> }` with `launch` on the root. No poll can
 *     claim a placeholder, and a replayed key never starts a second agent.
 *  3. `begin`: the host's `start` in the background; the answer comes at
 *     once. The host's id moves the root to the real session
 *     (`store.settleLaunch`), which then takes it as its first turn through
 *     the existing new-thread wake. A failed start sets `launch.error`.
 *
 * The run line is computed on read (`inboxRunOf`, packages/core/inbox-run-line.ts)
 * from the launch record, the host's `live` state, and its `sessions`, read
 * at most every 10 s and only while a window watches and a line could
 * change (a turn runs, or the host last said it waits on a prompt). A
 * person's reply to a launched session that is not live restarts it (the
 * host's `resume`), once per reply; one that does not take reads failed.
 *
 * The person's login shell is read once when the Inbox starts, ahead each
 * time the composer picks "Start Claude Code" and for Settings → Agents when
 * stale (while the switch was never set: what it follows), and by each start
 * for its own env, after the Send answered. A Send decides from the last
 * finished read and waits only for one under way, or when none ever finished. Every other host
 * call runs with the Inbox's own env through the launch filter
 * (`launchPlainEnv`), and none of them kills a process group.
 *
 * Window routes (same origin and `serverSession`; never over the tailnet for
 * Open and the settings):
 *   POST /api/inbox/launch/:id/stop      the host's stop (`claude stop`)
 *   POST /api/inbox/launch/:id/open      Terminal: the host's attach command (or what trusts the folder); macOS
 *   POST /api/inbox/launch/:id/delete    stop, remove, and the launch folder; the thread stays
 *   POST /api/inbox/launch/:id/retry     Try again after a failed start, restart or connection
 *   POST /api/inbox/launch/:id/trust     Trust folder: the host saves the trust, then Try again (owner only, tailnet too)
 *   POST /api/inbox/launch/settings      `{ full_permissions }` or `{ scratch_dir }` (Settings → Agents)
 *   GET  /api/inbox/launch/settings      the switch as it stands (never set: what the login shell says)
 *
 * And one route for a launched session's own permission hook, guarded like
 * the bridge (Claude Code's: inbox-launch-claude-permission.ts):
 *   POST /api/inbox/launch/:id/permission  the hook's long poll; the answer is the person's, from the thread
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { inboxId, type InboxComposeLaunch, type InboxLaunchAgent, type InboxLaunchRecord, type InboxListRow, type InboxMessage, type InboxProject, type InboxRun } from "@plannotator/core/inbox-types";
import { inboxRunOf, INBOX_RUN_START_GRACE_MS, type InboxRunHostState } from "@plannotator/core/inbox-run-line";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { derivePersonThreadSubject } from "@plannotator/core/inbox-questions";
import { inboxScratchCandidate, inboxScratchSlug } from "@plannotator/core/inbox-scratch";
import { loadConfig, resolveInboxLaunch, saveConfig } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { createClaudeLaunchHost } from "./inbox-launch-claude";
import { launchPlainEnv, type LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostPermissions, LaunchHostResult, LaunchLive, LaunchSessions } from "./inbox-launch-host";
import { openPermissionSince } from "./inbox-launch-permission";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

const AVAILABLE_TTL_MS = 30_000;
const HOST_TTL_MS = 10_000;

/** Compose's `to.launch`: a project's folder, or a new scratch folder. */
export type InboxLaunchTarget = { agent: InboxLaunchAgent; project_id: string } | { agent: InboxLaunchAgent; scratch: true };

/** How many `-N` names a scratch folder tries before it gives up. */
const SCRATCH_TRIES = 999;

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
  /**
   * The respawn a person's reply caused: once per reply (`for`, the newest
   * pending reply's id). `connected` once it polled again; `failed` when it
   * exited non-zero. Never retried by itself: Try again or a new reply.
   */
  respawn: { for: string; connected: boolean; failed: string | null; untrusted?: boolean } | null;
  /**
   * The session polled busy since the latest start or respawn. Until then a
   * turn it took (delivered) has not visibly begun: the line stays Starting
   * instead of blinking out between taking the turn and its next poll.
   */
  busySeen: boolean;
  /**
   * The newest reply still waiting when the person pressed Stop: it does not start the session again (that
   * would undo the Stop); the person's next reply does, and takes it along.
   */
  heldReply: string | null;
}

/** What the engine keeps per host: its availability (30 s), its sessions view (10 s), its permission transport. */
interface HostState {
  availability: { at: number; value: Promise<LaunchAvailability> } | null;
  /** The last answer, without waiting (null before the first). */
  lastAvailable: LaunchAvailability | null;
  view: { at: number; sessions: LaunchSessions | null } | null;
  fetching: Promise<void> | null;
  permissions: LaunchHostPermissions;
}

export function createInboxLaunch(options: {
  store: InboxStore;
  /** The mod's bridge poll: Claude Code's sessions say through it whether they are live and busy. */
  live: { runStateOf(session: string): LaunchLive | null };
  dataDir: string;
  serverSession: string;
  homeDir: string;
  platform: NodeJS.Platform;
  /** The person's login-shell env (inbox-launch-env.ts `createLoginEnv`): read for a launch, and for Settings → Agents while the switch was never set. */
  loginEnv: () => Promise<LaunchEnv>;
  /** The Inbox's own env (the plain calls: status, stop, respawn, rm). */
  ownEnv: () => Readonly<Record<string, string | undefined>>;
  /** Folders agents install themselves in (Claude Code's), searched after the Inbox's PATH (none in a sandboxed test). */
  installDirs: readonly string[];
  displayFolder: (path: string) => string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** The windows should read the list and open thread again (a start settled, a stop). */
  onChange: () => void;
  /** The argv that runs this Plannotator (the permission hook's command): the Inbox's own `selfCommand`. */
  selfCommand: readonly string[];
  /** More agents beside Claude Code, made with the engine's context (a test's fake host). Each is held by its own `agent`. */
  hosts?: (context: LaunchHostContext) => LaunchHost[];
  now?: () => number;
  log?: (line: string) => void;
}) {
  const { store, json } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  // config.json, parsed again only when the file changed: the list, the sweep and every route ask, flag off included.
  let configCache: { key: string; value: ReturnType<typeof resolveInboxLaunch> } | null = null;
  const config = () => {
    let key = "absent";
    try {
      const stat = statSync(join(getPlannotatorDataDir(), "config.json"));
      key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      // No config.json: the defaults.
    }
    if (configCache?.key !== key) configCache = { key, value: resolveInboxLaunch(loadConfig()) };
    return configCache.value;
  };
  const enabled = () => config().enabled;

  /**
   * Every call but a start: the Inbox's env through the launch filter, its PATH
   * followed by the last login shell's and the agents' own install folders
   * (`installDirs`), so a CLI the Inbox's PATH lacks is still found
   * without running a shell.
   */
  let loginPath: string[] = [];

  /**
   * The person's login shell: read once when the Inbox starts (`warm`), for Settings → Agents and the
   * composer's "Start Claude Code" while the switch was never set (what it follows), and by each start for
   * its own env, after the Send answered. One read at a time: callers meanwhile share it. Of a read only its
   * PATH (for the plain env) and the names the hosts keep (`shellNames`: Claude Code's skip-permissions
   * export and CLAUDE_CONFIG_DIR) are kept; the env itself is never held for a launch.
   */
  let shell: { kept: LaunchEnv; at: number } | null = null;
  /** Settings → Agents reads the shell again only when its last read is older than this. */
  const SHELL_READ_FRESH_MS = 60_000;
  const shellFresh = () => shell !== null && now() - shell.at < SHELL_READ_FRESH_MS;
  let reading: Promise<LaunchEnv> | null = null;
  const readLogin = (): Promise<LaunchEnv> => {
    reading ??= (async () => {
      try {
        const login = await options.loginEnv();
        if (login.PATH) loginPath = login.PATH.split(delimiter).filter(Boolean);
        const kept: LaunchEnv = {};
        for (const name of hostList.flatMap((host) => host.shellNames)) if (login[name] !== undefined) kept[name] = login[name]!;
        shell = { kept, at: now() };
        return login;
      } finally {
        reading = null;
      }
    })();
    return reading;
  };

  // ── Scratch folders (PR 3): `<root>/<thread-name slug>`, then `-2`, `-3` when taken ──

  /** Where new scratch folders go: Settings → Agents' `inboxLaunch.scratchDir`, else `<dataDir>/scratch`. Moving it applies to new folders only. */
  const scratchRoot = () => config().scratchDir ?? join(options.dataDir, "scratch");
  /** A folder's identity (`<dev>:<ino>`), or null when it is not there. */
  const inodeOf = (folder: string): string | null => {
    try {
      const stat = lstatSync(folder, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  };
  /**
   * A scratch folder is still the one the Inbox made: a real folder named as a slug, with no symbolic link
   * anywhere on its path, so it is still right inside the root's real path it was made in (the record holds
   * that real path), and the same folder (`inode`, recorded when it was made), never one made at that path
   * since. Only then may Delete purge and remove it; anything else (a link swapped in, pointing out of the
   * root, another folder, or none) is left alone.
   */
  const scratchIntact = (folder: string, inode: string | undefined): boolean => {
    try {
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(basename(folder)) && lstatSync(folder).isDirectory() && realpathSync(folder) === folder && !!inode && inodeOf(folder) === inode;
    } catch {
      return false;
    }
  };
  /** `path` with its links resolved: the real path of the nearest folder that exists, then the rest as given. */
  const realPathOf = (path: string): string => {
    const rest: string[] = [];
    for (let dir = resolve(path); ; dir = dirname(dir)) {
      try {
        return join(realpathSync(dir), ...rest.reverse());
      } catch {
        if (dirname(dir) === dir) return resolve(path);
        rest.push(basename(dir));
      }
    }
  };
  /**
   * The git repository holding `path` (a `.git` in it or a folder above it, as given or through a link), or null. A
   * scratch root is never in one: each folder would join that repository's project, not its own.
   */
  const repositoryHolding = (path: string): string | null => {
    for (const start of new Set([resolve(path), realPathOf(path)])) {
      for (let dir = start; ; dir = dirname(dir)) {
        if (existsSync(join(dir, ".git"))) return dir;
        if (dirname(dir) === dir) break;
      }
    }
    return null;
  };
  const scratchRefused = (text: string) => new InboxError("scratch_unavailable", `${text} Nothing was sent.`, { field: "to.launch" });
  /** Make the new scratch folder for a thread name: the first free `<slug>`, `<slug>-2`, … under the root's real path. Never follows a link. */
  const makeScratch = (name: string | null): { folder: string; inode: string } => {
    const root = scratchRoot();
    const repository = repositoryHolding(root);
    if (repository) throw scratchRefused(`${options.displayFolder(root)} is inside the git repository ${options.displayFolder(repository)}. Pick a scratch folder outside any repository in Settings → Agents.`);
    let realRoot: string;
    try {
      mkdirSync(root, { recursive: true });
      realRoot = realpathSync(root);
    } catch (error) {
      throw scratchRefused(`A scratch folder can't be made in ${options.displayFolder(root)} (${(error as NodeJS.ErrnoException).code ?? "error"}). Change it in Settings → Agents.`);
    }
    // A path any launch (a deleted one too) was given is never given again: one folder path, one launch.
    const given = new Set(roots().flatMap((m) => (m.launch!.scratch ? [m.launch!.folder] : [])));
    const slug = inboxScratchSlug(name);
    for (let n = 1; n <= SCRATCH_TRIES; n++) {
      const folder = join(realRoot, inboxScratchCandidate(slug, n));
      if (given.has(folder)) continue;
      try {
        // Not recursive: a name already there (a folder, a file, a link, a dangling link) is taken, never followed.
        mkdirSync(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw scratchRefused(`A scratch folder can't be made in ${options.displayFolder(root)} (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      }
      const inode = inodeOf(folder);
      if (!inode || !scratchIntact(folder, inode)) {
        rmSync(folder, { recursive: true, force: true });
        throw scratchRefused(`The new scratch folder isn't inside ${options.displayFolder(root)}.`);
      }
      return { folder, inode };
    }
    throw scratchRefused(`Every scratch folder name for this thread is taken in ${options.displayFolder(root)}. Rename the thread.`);
  };
  /**
   * Delete's last step for a scratch launch: the host's purge (that folder's sessions and transcripts) and
   * the folder itself, only while it is intact. Never for a project folder.
   */
  const removeScratch = async (host: LaunchHost, launch: InboxLaunchRecord): Promise<boolean> => {
    if (!launch.scratch) return false;
    const kept = () => {
      log(`Inbox launch ${launch.id}: scratch folder ${launch.folder} kept (not the folder the Inbox made: a link, another folder, or gone)`);
      return false;
    };
    if (!scratchIntact(launch.folder, launch.scratch_inode)) return kept();
    const purge = await host.purge(launch.folder);
    // The purge took a while: the folder is looked at again right before it goes.
    if (!scratchIntact(launch.folder, launch.scratch_inode)) return kept();
    rmSync(launch.folder, { recursive: true, force: true });
    log(`Inbox launch ${launch.id}: scratch folder removed (${purge.skipped ? `purge skipped: ${purge.skipped}` : `purge ${purge.exitCode}`})`);
    return true;
  };
  const environment = async (): Promise<AgentEnvironment> =>
    createAgentEnvironmentFor({
      platform: options.platform,
      homeDir: options.homeDir,
      env: launchPlainEnv(options.ownEnv(), [...loginPath, ...options.installDirs]),
    });

  const launchDir = (id: string) => join(store.dir, "launch", id);
  const startLog = (id: string, text: string) => {
    try {
      mkdirSync(launchDir(id), { recursive: true, mode: 0o700 });
      appendFileSync(join(launchDir(id), "start.log"), `── ${new Date(now()).toISOString()}\n${text.trimEnd()}\n`, { mode: 0o600 });
    } catch {
      // Best effort: the log is for the person reading it by hand.
    }
  };

  // ── The hosts: one per agent ──
  const context: LaunchHostContext = {
    dataDir: options.dataDir,
    homeDir: options.homeDir,
    platform: options.platform,
    selfCommand: options.selfCommand,
    ownEnv: options.ownEnv,
    environment,
    shell: () => shell?.kept ?? null,
    loginEnv: () => readLogin(),
    config,
    launchDir,
    startLog,
    displayFolder: options.displayFolder,
    bridge: options.live,
    log,
  };
  const claude = createClaudeLaunchHost(context);
  /** The agents the Inbox can start, one per line. */
  const ownHosts: LaunchHost[] = [
    claude,
  ];
  /** By each host's own `agent`, so the key a record is looked up by is the agent the host writes. */
  const hosts: Record<string, LaunchHost> = Object.fromEntries([...ownHosts, ...(options.hosts?.(context) ?? [])].map((host) => [host.agent, host]));
  const hostList = Object.values(hosts);
  /** The host of a launch's agent; null for an agent with no host here. */
  const hostOf = (launch: InboxLaunchRecord): LaunchHost | null => (Object.hasOwn(hosts, launch.agent) ? hosts[launch.agent]! : null);
  const roots = () => store.launchedRoots();
  const states = new Map<LaunchHost, HostState>();
  const stateOf = (host: LaunchHost): HostState => states.get(host)!;
  /** The host's last word on a session (its cached `sessions`), or null when not read. */
  const sessionIn = (host: LaunchHost, ref: string | null): InboxRunHostState | null => {
    const sessions = stateOf(host).view?.sessions;
    return ref && sessions ? sessions(ref) : null;
  };
  for (const host of hostList) {
    const mine = (root: InboxMessage) => !root.launch!.deleted_at && hostOf(root.launch!) === host;
    states.set(host, {
      availability: null,
      lastAvailable: null,
      view: null,
      fetching: null,
      permissions: host.permissions({
        store,
        launchDir,
        rootOf: (launchId) => roots().find((root) => root.launch!.id === launchId && mine(root)) ?? null,
        roots: () => roots().filter(mine),
        displayFolder: options.displayFolder,
        host: { stateOf: (ref) => sessionIn(host, ref), readAt: () => stateOf(host).view?.at ?? 0 },
        onChange: options.onChange,
        now,
        log,
      }),
    });
  }

  // ── Availability: the host's own check, at most every 30 s ──
  const available = (host: LaunchHost, fresh = false): Promise<LaunchAvailability> => {
    const state = stateOf(host);
    if (!state.availability || fresh || now() - state.availability.at > AVAILABLE_TTL_MS) {
      state.availability = { at: now(), value: host.available().catch(() => ({ ok: false, missing: false, reason: "could not check" }) as LaunchAvailability) };
    }
    return state.availability.value;
  };
  const refreshAvailable = (host: LaunchHost) => void available(host).then((value) => (stateOf(host).lastAvailable = value));

  // ── The host's view: one `sessions` read per host, shared, at most every 10 s, only while something needs it ──
  const refreshHost = (host: LaunchHost): Promise<void> => {
    const state = stateOf(host);
    if (state.fetching) return state.fetching;
    state.fetching = host
      .sessions()
      .then((sessions) => {
        state.view = { at: now(), sessions };
      })
      .catch(() => {
        state.view = { at: now(), sessions: null };
      })
      .finally(() => {
        state.fetching = null;
        options.onChange();
      });
    return state.fetching;
  };
  /** Stale after 10 s, or once an answer settled since the last read (one read then says where the session is). */
  const hostStale = (host: LaunchHost) => {
    const state = stateOf(host);
    return !state.view || now() - state.view.at > HOST_TTL_MS || state.permissions.readDue?.(state.view.at) === true;
  };

  const memos = new Map<string, Memo>();
  const memoOf = (launch: InboxLaunchRecord): Memo => {
    let memo = memos.get(launch.id);
    if (!memo) {
      memo = { startedAt: Date.parse(launch.started_at), again: false, stoppedAt: null, waitingSince: null, quietPolls: null, respawn: null, busySeen: false, heldReply: null };
      memos.set(launch.id, memo);
    }
    return memo;
  };

  /** The host's live state of a launched root's session, with Stop counted at once. */
  const liveOf = (host: LaunchHost, root: InboxMessage, memo: Memo) => {
    const session = root.to?.session;
    if (!session || session.startsWith("launch:")) return null;
    const state = host.live(session);
    if (state && memo.quietPolls !== null) {
      if (state.polls <= memo.quietPolls) return null;
      // It polled since: started again (a respawn, or by hand in a terminal).
      memo.quietPolls = null;
      memo.stoppedAt = null;
    }
    if (state && memo.respawn) memo.respawn.connected = true;
    if (state?.busy === true) memo.busySeen = true;
    return state;
  };

  /** Why the reply's respawn did not take, or null: it failed, or it never polled within the grace. */
  const respawnFailedOf = (memo: Memo): string | null => {
    // Stopped by the person: "You stopped", never a failure.
    if (!memo.respawn || memo.respawn.connected || memo.stoppedAt !== null) return null;
    if (memo.respawn.failed) return memo.respawn.failed;
    return now() - memo.startedAt >= INBOX_RUN_START_GRACE_MS ? "It started again but did not connect to the Inbox." : null;
  };

  /** The reply's restart was refused because the agent does not trust the folder. */
  const respawnUntrustedOf = (memo: Memo): boolean => memo.respawn?.untrusted === true && respawnFailedOf(memo) !== null;

  /**
   * A turn waits for the session: the root or a reply is not taken yet, or it
   * was taken since the latest start but the session has neither polled busy
   * nor answered.
   */
  const turnWaitingOf = (root: InboxMessage, memo: Memo): boolean => {
    if (!root.delivery) return true;
    if (root.to && store.pendingReplies(root.to.session, { tags: true }).length > 0) return true;
    if (memo.busySeen) return false;
    const lastId = store.threadMessageIds(root.thread_id).at(-1);
    const last = lastId ? store.message(lastId) : null;
    // The person's latest, unless it went to another session (re-addressed).
    return last?.author.kind === "person" && (!last.to || last.to.session === root.to?.session);
  };

  /** The run line of a launched root; null for an agent with no host here. */
  const runOfRoot = (root: InboxMessage): InboxRun | null => {
    const launch = root.launch!;
    const host = hostOf(launch);
    if (launch.deleted_at || !host) return null;
    const state = stateOf(host);
    const memo = memoOf(launch);
    const live = liveOf(host, root, memo);
    // A host read from before the last answer settled still shows our own prompt: never "waiting on Terminal".
    const settled = state.permissions.settledAfter?.(launch.id) ?? null;
    const hostState = settled !== null && (state.view?.at ?? 0) < settled ? null : sessionIn(host, launch.session_ref);
    if (hostState && hostState !== "absent" && hostState.status === "waiting" && hostState.waitingFor) memo.waitingSince ??= now();
    else memo.waitingSince = null;
    const project = store.project(root.project_id)?.name ?? launch.folder;
    const last = state.lastAvailable;
    return inboxRunOf({
      launch,
      project,
      now: now(),
      startedAt: memo.startedAt,
      again: memo.again,
      cliAvailable: last === null ? null : !(last.ok === false && last.missing),
      live,
      turnWaiting: turnWaitingOf(root, memo),
      seenLive: !!root.delivery,
      host: hostState,
      waitingSince: memo.waitingSince,
      respawnFailed: respawnFailedOf(memo),
      respawnUntrusted: respawnUntrustedOf(memo),
      stoppedByPersonAt: memo.stoppedAt,
      stoppedNote: host.stoppedNote?.(launch) ?? null,
      attachCommand: host.attach(launch),
      permissionSince: openPermissionSince(store, root.thread_id),
    });
  };

  /**
   * Whether the host's view could change this root's line: it last said it
   * waits on a prompt (until it says otherwise), a turn runs (a prompt may
   * block it), or it is not live past the start.
   */
  const needsHost = (host: LaunchHost, root: InboxMessage): boolean => {
    const launch = root.launch!;
    if (launch.deleted_at || launch.error || !launch.session_ref) return false;
    // A permission question waits: the host says whether the person answered it in Terminal meanwhile.
    const permissions = stateOf(host).permissions;
    if (permissions.holds?.(launch.id)) return true;
    // An answer not yet read past: the host says whether the session went on or waits on its own dialog.
    const settled = permissions.settledAfter?.(launch.id) ?? null;
    if (settled !== null && (stateOf(host).view?.at ?? 0) < settled) return true;
    const cached = sessionIn(host, launch.session_ref);
    if (cached && cached !== "absent" && cached.status === "waiting") return true;
    const memo = memoOf(launch);
    const live = liveOf(host, root, memo);
    if (live) return live.busy === true;
    if (now() - memo.startedAt < INBOX_RUN_START_GRACE_MS) return false;
    const state = sessionIn(host, launch.session_ref);
    return !(state === "absent" || (state && (state.state === "stopped" || state.state === "done")));
  };

  /** A launch the routes act on: its root and host. An agent with no host here reads as no launch. */
  const launchById = (launchId: string): { root: InboxMessage; host: LaunchHost } => {
    const root = roots().find((m) => m.launch!.id === launchId);
    const host = root ? hostOf(root.launch!) : null;
    if (!root || !host) throw new InboxError("launch_not_found", `No launch ${launchId}.`);
    return { root, host };
  };

  /**
   * Look at every launch: respawn a stopped session someone wrote to, and,
   * only while a window watches (`watched`), keep each host's check and
   * view fresh where a line could change. An agent with no host is skipped.
   */
  const sweep = (watched: boolean) => {
    if (!enabled()) {
      // Launch turned off: a question no one can answer any more is withdrawn (nothing to do once none is open).
      for (const root of roots()) {
        const host = hostOf(root.launch!);
        if (host && !root.launch!.deleted_at) stateOf(host).permissions.withdrawAll(root);
      }
      return;
    }
    const all = roots().filter((root) => !root.launch!.deleted_at && hostOf(root.launch!));
    if (all.length === 0) return;
    for (const root of all) maybeRespawn(root);
    for (const host of hostList) stateOf(host).permissions.sweep();
    if (!watched) return;
    for (const host of hostList) {
      const mine = all.filter((root) => hostOf(root.launch!) === host);
      if (mine.length === 0) continue;
      const state = stateOf(host);
      if (state.lastAvailable === null || (state.availability && now() - state.availability.at > AVAILABLE_TTL_MS)) refreshAvailable(host);
      if (hostStale(host) && mine.some((root) => needsHost(host, root))) void refreshHost(host);
    }
  };

  // ── Start ──

  /** Launches whose start is running now: Try again waits, and Delete leaves the new session to `run` to remove. */
  const starting = new Set<string>();
  /** A Delete under way, by launch id: a second one (a double click) waits for it and answers the same. */
  const deleting = new Map<string, Promise<Record<string, unknown>>>();
  /** A Trust folder under way, by launch: a double click waits for it and answers the same. */
  const trusting = new Map<string, Promise<Record<string, unknown>>>();
  /** A Stop under way, by launch id: no reply starts the session again until it is done. */
  const stopping = new Set<string>();

  /** Start (or start again after a failed start) the agent for a launched root, in the background. */
  const run = async (root: InboxMessage, host: LaunchHost, again: boolean): Promise<void> => {
    const launch = root.launch!;
    const memo = memoOf(launch);
    memo.startedAt = now();
    memo.again = again;
    memo.stoppedAt = null;
    memo.respawn = null;
    memo.busySeen = false;
    memo.heldReply = null;
    starting.add(launch.id);
    try {
      // The person's login env, read for this start only (after the Send answered; never kept).
      const login = await readLogin();
      const name = root.thread_name ?? root.subject ?? "Inbox";
      const result = await host.start(launch, { name, login });
      // Deleted while it started: the session it made goes too, and the thread stays as the person left it.
      if (store.message(root.id)?.launch?.deleted_at) {
        if (result.ok) {
          const stop = await host.stop(result.ref);
          const rm = await host.remove(result.ref);
          log(`Inbox launch ${launch.id}: deleted while starting; removed ${result.ref} (stop ${stop.exitCode}, rm ${rm.exitCode})`);
        }
        await removeScratch(host, launch);
        rmSync(launchDir(launch.id), { recursive: true, force: true });
        return;
      }
      if (result.ok) store.settleLaunch(root.id, { to: { host: launch.agent, session: result.session }, session_ref: result.ref });
      else store.settleLaunch(root.id, { error: { code: result.code, text: result.text, at: new Date(now()).toISOString() } });
      log(`Inbox launch ${launch.id}: ${result.ok ? `started ${result.ref}` : `did not start (${result.code})`}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      startLog(launch.id, `error: ${text}`);
      if (!store.message(root.id)?.launch?.deleted_at) store.settleLaunch(root.id, { error: { code: "failed", text, at: new Date(now()).toISOString() } });
    } finally {
      starting.delete(launch.id);
      stateOf(host).view = null;
      options.onChange();
    }
  };

  // ── Respawn on reply: a person's message for a launched session that is not live ──
  const respawning = new Set<string>();
  /** The host's `resume` once; a failure is kept (and the CLI looked at again, for screen 15). */
  const respawn = (root: InboxMessage, host: LaunchHost, forReply: string) => {
    const launch = root.launch!;
    const memo = memoOf(launch);
    respawning.add(launch.id);
    memo.startedAt = now();
    memo.again = true;
    memo.stoppedAt = null;
    memo.quietPolls = host.live(root.to!.session)?.polls ?? memo.quietPolls;
    memo.respawn = { for: forReply, connected: false, failed: null };
    memo.busySeen = false;
    memo.heldReply = null;
    const attempt = memo.respawn;
    options.onChange();
    void host
      .resume(launch)
      // A host whose resume throws is a failed restart, never an unhandled rejection (it would end the Inbox).
      .catch((error: unknown) => ({ exitCode: 1, text: `error: ${error instanceof Error ? error.message : String(error)}`, failure: { code: "failed" as const, text: "It did not start again." } }))
      .then(async (result) => {
        startLog(launch.id, `respawn ${launch.session_ref}: exit ${result.exitCode}\n${result.text}`);
        if (!result.failure) return;
        attempt.failed = result.failure.text;
        // The agent may check trust before a restart too (a scratch folder that became its own repository needs its own).
        attempt.untrusted = result.failure.code === "untrusted";
        stateOf(host).lastAvailable = await available(host, true);
      })
      .finally(() => {
        options.onChange();
        respawning.delete(launch.id);
        stateOf(host).view = null;
      });
  };
  const maybeRespawn = (root: InboxMessage) => {
    const launch = root.launch!;
    const host = hostOf(launch);
    // Only a session that connected once: one that never did is "not connected", and respawning it would not help.
    if (!host || launch.deleted_at || launch.error || !launch.session_ref || !root.to || !root.delivery || respawning.has(launch.id) || starting.has(launch.id)) return;
    // A Stop or a Delete under way: the session is going, never started again meanwhile (a host's `live` may
    // read null as soon as its stop begins).
    if (stopping.has(launch.id) || deleting.has(launch.id)) return;
    const memo = memoOf(launch);
    if (liveOf(host, root, memo)) return;
    if (now() - memo.startedAt < INBOX_RUN_START_GRACE_MS) return;
    const newest = store.pendingReplies(root.to.session, { tags: true }).at(-1);
    // Once per reply: one that did not take waits for Try again or the person's next reply.
    if (!newest || memo.respawn?.for === newest.id || memo.heldReply === newest.id) return;
    respawn(root, host, newest.id);
  };
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message" || !enabled()) return;
    const message = line.record;
    if (message.author.kind !== "person" || message.id === message.thread_id || message.delivery) return;
    const root = store.message(message.thread_id);
    if (root?.launch) queueMicrotask(() => maybeRespawn(store.message(root.id) ?? root));
  });

  // ── Routes ──

  /** Settings → Agents: the full-permissions switch (Claude Code's words, `settingsState`) and the scratch root. */
  const settingsState = () => ({
    enabled: enabled(),
    ...claude.settingsState(),
    // Settings → Agents' "Scratch folders": where new ones go.
    scratch_dir: scratchRoot(),
    scratch_dir_shown: options.displayFolder(scratchRoot()),
  });
  /** `owner`: the machine's owner, here or over the tailnet (a guest the allow list let in is not). */
  const route = async (req: Request, path: string, via: "local" | "tailnet" | string, owner: boolean = via === "local"): Promise<Response | null> => {
    const match = /^\/api\/inbox\/launch\/(settings|lch_[0-9A-HJKMNP-TV-Z]{26})(?:\/(stop|open|delete|retry|trust))?$/.exec(path);
    if (!match) return null;
    if (!enabled()) return json({ error: "Launch is off.", code: "launch_off" }, 404);
    // Settings → Agents, shown: the switch as it stands; never set, the login shell read again when stale.
    if (req.method === "GET" && match[1] === "settings" && !match[2]) {
      if (via === "tailnet") return json({ error: "Only from this computer.", code: "owner_only" }, 403);
      // Never another site's page: a read here may start the person's login shell.
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      // `ahead=1` (the composer picked "Start Claude Code"): read now, off the Send's path, so a change to the
      // person's rc counts for that Send. One read at a time either way.
      const ahead = new URL(req.url).searchParams.get("ahead") === "1";
      if (config().fullPermissions === null && (ahead || !shellFresh())) await readLogin();
      return json({ launch: settingsState() });
    }
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const localOnly = () => json({ error: "Only from this computer.", code: "owner_only" }, 403);
    if (match[1] === "settings") {
      if (match[2]) return null;
      if (via === "tailnet") return localOnly();
      if ("scratch_dir" in body) {
        // Settings → Agents' "Scratch folders": a full path (`~/` is the person's home); empty or null is the default.
        const raw = body.scratch_dir;
        if (raw !== null && typeof raw !== "string") throw new InboxError("validation_error", "scratch_dir: a folder path, or null.", { field: "scratch_dir" });
        const typed = (raw ?? "").trim();
        const path = typed === "~" ? options.homeDir : typed.startsWith("~/") ? join(options.homeDir, typed.slice(2)) : typed;
        if (path && (!isAbsolute(path) || resolve(path) === resolve("/"))) throw new InboxError("validation_error", "Give a full path, such as ~/scratch.", { field: "scratch_dir" });
        const repository = path ? repositoryHolding(path) : null;
        if (repository) {
          throw new InboxError("validation_error", `That folder is inside the git repository ${options.displayFolder(repository)}. Pick one outside any repository.`, { field: "scratch_dir" });
        }
        const { scratchDir: _was, ...rest } = loadConfig().inboxLaunch ?? {};
        saveConfig({ inboxLaunch: { ...rest, ...(path ? { scratchDir: resolve(path) } : {}) } });
        if (config().scratchDir !== (path ? resolve(path) : null)) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed.");
        return json({ launch: settingsState() });
      }
      if (typeof body.full_permissions !== "boolean") throw new InboxError("validation_error", "full_permissions: a boolean.", { field: "full_permissions" });
      const current = loadConfig().inboxLaunch ?? {};
      saveConfig({ inboxLaunch: { ...current, fullPermissions: body.full_permissions } });
      if (config().fullPermissions !== body.full_permissions) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed.");
      return json({ launch: settingsState() });
    }
    const { root, host } = launchById(match[1]!);
    const launch = root.launch!;
    const state = stateOf(host);
    switch (match[2]) {
      case "stop": {
        if (!launch.session_ref) throw new InboxError("launch_not_found", "That session never started.");
        const memo = memoOf(launch);
        // What waits now was written before the Stop: it stays for the person's next reply.
        memo.heldReply = root.to ? (store.pendingReplies(root.to.session, { tags: true }).at(-1)?.id ?? null) : null;
        stopping.add(launch.id);
        let result: LaunchHostResult;
        try {
          result = await host.stop(launch.session_ref);
        } finally {
          stopping.delete(launch.id);
        }
        startLog(launch.id, `stop ${launch.session_ref}: exit ${result.exitCode}\n${result.text}`);
        memo.stoppedAt = now();
        memo.startedAt = Math.min(memo.startedAt, now() - INBOX_RUN_START_GRACE_MS);
        // Nothing waits on a stopped session's prompt: its questions are withdrawn at once.
        state.permissions.withdrawAll(root);
        // Its last polls still read as live for a while: from now it counts as live only once it polls anew.
        if (root.to) memo.quietPolls = host.live(root.to.session)?.polls ?? memo.quietPolls;
        state.view = null;
        options.onChange();
        return json({ run: runOfRoot(store.message(root.id)!) });
      }
      case "open": {
        if (via === "tailnet") return localOnly();
        if (options.platform !== "darwin") throw new InboxError("open_unavailable", "Open in Terminal is for macOS; copy the command instead.");
        // A start or restart the agent refused for trust: the host's command where trust is accepted.
        const untrusted = !!launch.error || respawnUntrustedOf(memoOf(launch));
        const command = host.terminal(launch, untrusted);
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
        // A Delete under way (a double click): the same answer, once it is done.
        const under = deleting.get(launch.id);
        if (under) return json(await under);
        // Deleted already (a second Delete, from a stale window): nothing more. Its folder path may be another launch's now.
        if (launch.deleted_at) return json({ ok: true });
        const done = (async (): Promise<Record<string, unknown>> => {
          // Still starting: `run` removes the session it makes once it sees `deleted_at`.
          if (launch.session_ref) {
            const stop = await host.stop(launch.session_ref);
            const rm = await host.remove(launch.session_ref);
            log(`Inbox launch ${launch.id}: deleted (stop ${stop.exitCode}, rm ${rm.exitCode})`);
          }
          state.permissions.withdrawAll(root);
          state.permissions.forget?.(launch.id);
          // A project folder: never purged (it clears every session of the folder, and this is the person's
          // project). A scratch folder the Inbox made: purged and removed, by `run` when it still starts.
          const scratchRemoved = starting.has(launch.id) ? null : await removeScratch(host, launch);
          rmSync(launchDir(launch.id), { recursive: true, force: true });
          store.settleLaunch(root.id, { deleted_at: new Date(now()).toISOString() });
          memos.delete(launch.id);
          options.onChange();
          // `scratch_removed: false`: the folder was kept (not the one the Inbox made). Still starting: `run` removes it.
          return { ok: true, ...(launch.scratch && scratchRemoved !== null ? { scratch_removed: scratchRemoved } : {}) };
        })();
        deleting.set(launch.id, done);
        try {
          return json(await done);
        } finally {
          deleting.delete(launch.id);
        }
      }
      case "retry": {
        if (starting.has(launch.id) || respawning.has(launch.id) || trusting.has(launch.id)) throw new InboxError("validation_error", "It is starting already.");
        if (!isFolder(launch.folder)) throw new InboxError("folder_missing", `${options.displayFolder(launch.folder)} isn't there any more.`);
        tryAgain(root, host);
        return json({ run: runOfRoot(store.message(root.id)!) });
      }
      case "trust": {
        if (!owner) throw new InboxError("owner_only", "Only this computer's owner can trust a folder.");
        // A click under way (a double click): the same answer, once it is done.
        const under = trusting.get(launch.id);
        if (under) return json(await under);
        const done = (async (): Promise<Record<string, unknown>> => {
          const runNow = () => ({ run: runOfRoot(store.message(root.id)!) });
          // Nothing refused now (a second click, a stale window): the line as it stands, never a second start.
          if (!refusedForTrust(root)) return runNow();
          if (!isFolder(launch.folder)) throw new InboxError("folder_missing", `${options.displayFolder(launch.folder)} isn't there any more.`);
          const offer = host.trustOffer?.(launch);
          if (!offer) throw new InboxError("trust_failed", `${host.name} can't trust this folder from here.`);
          // The person agreed to the line they read: a folder that changed since gets a new read, and a new click.
          if ((body.warning ?? null) !== offer.warning) throw new InboxError("trust_warning_changed", `This folder changed, so nothing was saved. ${offer.warning ?? "It no longer has anything to warn about."} Click Trust folder again if that's fine.`);
          try {
            await offer.accept();
          } catch (error) {
            throw new InboxError("trust_failed", error instanceof Error ? error.message : String(error));
          }
          // The write can wait on the agent's own lock: a Delete may have come through meanwhile.
          const current = store.message(root.id)!;
          if (refusedForTrust(current)) tryAgain(current, host);
          return runNow();
        })();
        trusting.set(launch.id, done);
        try {
          return json(await done);
        } finally {
          trusting.delete(launch.id);
        }
      }
    }
    return null;
  };

  /** The start or restart waiting on Try again was refused for trust, and nothing is under way. */
  const refusedForTrust = (root: InboxMessage): boolean => {
    const launch = root.launch!;
    if (launch.deleted_at || starting.has(launch.id) || respawning.has(launch.id)) return false;
    return runOfRoot(root)?.untrusted === true;
  };

  /** Try again, for a launch that failed. */
  const tryAgain = (root: InboxMessage, host: LaunchHost): void => {
    const launch = root.launch!;
    const memo = memoOf(launch);
    // A reply's respawn that did not take: respawn once more (the session exists; a new start would make a second).
    if (!launch.error && launch.session_ref && root.to && respawnFailedOf(memo)) {
      respawn(root, host, memo.respawn!.for);
      return;
    }
    if (!launch.error) {
      // Started but never connected (or cut off by an Inbox restart): respawn the session it made, or start anew without one.
      if (runOfRoot(root)?.state !== "failed") throw new InboxError("validation_error", "That launch did not fail.");
      if (launch.session_ref && root.to && !root.to.session.startsWith("launch:")) respawn(root, host, memo.respawn?.for ?? root.id);
      // No session was made: a first start, not "again".
      else void run(root, host, false);
      return;
    }
    // The start never ran (untrusted, failed): Try again is its first real start, never "Starting … again".
    void run(store.settleLaunch(root.id, { error: null }), host, false);
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
    /** Once at Inbox start, with launch on: the login shell read ahead, so a Send rarely waits on it. */
    warm(): void {
      if (enabled()) void readLogin().catch(() => {});
    },
    route,
    sweep,
    stop: () => {
      unsubscribe();
      for (const host of hostList) host.close?.();
    },

    /**
     * A launched session's permission hook (`POST /api/inbox/launch/:id/permission`), after the
     * caller's connection guard: null for any other path. Off, 404 `launch_off` (the hook then says nothing).
     * The launch's host answers; an id no thread has goes to the host that takes such calls, which refuses its key.
     */
    async permissionRoute(req: Request, path: string): Promise<Response | null> {
      const match = /^\/api\/inbox\/launch\/(lch_[0-9A-HJKMNP-TV-Z]{26})\/permission$/.exec(path);
      if (!match) return null;
      if (!enabled()) return json({ error: "Launch is off.", code: "launch_off" }, 404);
      const root = roots().find((m) => m.launch!.id === match[1]);
      const host = root ? hostOf(root.launch!) : hostList.find((h) => stateOf(h).permissions.handle);
      const permissions = host ? stateOf(host).permissions : null;
      if (!permissions?.handle) throw new InboxError("launch_not_found", `No launch ${match[1]}.`);
      return permissions.handle(req, match[1]!);
    },

    /** Compose's `to.launch`, when launch is on: `{ agent, project_id }` or `{ agent, scratch: true }`; null for any other `to`. */
    target(to: unknown): InboxLaunchTarget | null {
      if (!to || typeof to !== "object" || !("launch" in to)) return null;
      if (!enabled()) throw new InboxError("launch_off", "Starting agents from the Inbox is off.");
      const value = (to as { launch: unknown }).launch as Record<string, unknown> | null;
      const host = value && typeof value === "object" && typeof value.agent === "string" && Object.hasOwn(hosts, value.agent) ? hosts[value.agent]! : null;
      if (host && value!.scratch === true && value!.project_id === undefined) return { agent: host.agent, scratch: true };
      if (!host || typeof value!.project_id !== "string") {
        const agent = hostList.map((h) => `"${h.agent}"`).join(" | ");
        throw new InboxError("validation_error", `to.launch: { agent: ${agent}, project_id } or { agent: ${agent}, scratch: true }.`, { field: "to.launch" });
      }
      return { agent: host.agent, project_id: value!.project_id };
    },

    /**
     * Check before anything is written: the folder is there and the agent can start. A scratch launch makes
     * its folder last (after those checks), named from the thread's name (`name`, else the subject of `body`),
     * and `resolveProject` makes it a project as usual; `abandon` removes it when the thread is then not written.
     */
    async prepare(
      target: InboxLaunchTarget,
      input: { name: string | null; body: string; resolveProject: (path: string) => Promise<InboxProject> },
    ): Promise<{ project: InboxProject; to: { host: string; session: string }; launch: InboxLaunchRecord }> {
      const host = Object.hasOwn(hosts, target.agent) ? hosts[target.agent]! : null;
      if (!host) throw new InboxError("agent_unavailable", `${target.agent} can't be started here. Nothing was sent.`);
      const chosen = "project_id" in target ? store.project(target.project_id) : null;
      if ("project_id" in target && !chosen) throw new InboxError("project_not_found", `No project ${target.project_id}.`);
      if (chosen && !isFolder(chosen.root)) {
        throw new InboxError("folder_missing", `${options.displayFolder(chosen.root)} isn't there any more. Pick another project. Nothing was sent.`, { field: "to.launch" });
      }
      const ok = await available(host, true);
      stateOf(host).lastAvailable = ok;
      if (!ok.ok) throw new InboxError("agent_unavailable", `${host.name} can't be started here: ${ok.reason}. Nothing was sent.`);
      const id = inboxId("lch");
      // How it starts, fixed for this launch (the host's `startOf`: for Claude Code the switch, the person's own
      // setup with this folder's settings, and the last finished shell read, however old; the start reads the
      // shell again for its own env). Send waits on the shell only to finish a read already under way (the
      // composer's read ahead, or another launch's start), or when no read ever finished (`warm` reads one at
      // Inbox start).
      if (reading || shell === null) await readLogin();
      const made = chosen ? null : makeScratch(input.name?.trim() || derivePersonThreadSubject(input.body));
      const folder = made ? made.folder : chosen!.root;
      let project: InboxProject;
      try {
        project = chosen ?? (await input.resolveProject(folder));
      } catch (error) {
        if (made) rmSync(folder, { recursive: true, force: true });
        throw error;
      }
      const start = host.startOf(folder);
      const launch: InboxLaunchRecord = {
        id,
        agent: host.agent,
        session_ref: null,
        folder,
        scratch: !chosen,
        ...(made ? { scratch_inode: made.inode } : {}),
        started_at: new Date(now()).toISOString(),
        ...(start.full ? { full_permissions: true } : {}),
        ...(start.ownMode ? { own_mode: true } : {}),
        ...(start.bypass ? { bypass_available: true } : {}),
      };
      return { project, to: { host: host.agent, session: `launch:${id}` }, launch };
    },

    /**
     * The thread was not written after `prepare` (a failed write, or a replay that landed meanwhile): the scratch
     * folder it made goes, and the project made for it while no thread is in it.
     */
    abandon(launch: InboxLaunchRecord, project: InboxProject): void {
      if (!launch.scratch) return;
      if (scratchIntact(launch.folder, launch.scratch_inode)) rmSync(launch.folder, { recursive: true, force: true });
      if (project.root === launch.folder && store.project(project.id) && store.listRows({ projectId: project.id }).length === 0) store.deleteProject(project.id);
    },

    /** The thread is written: start the agent in the background. */
    begin(root: InboxMessage): void {
      const host = hostOf(root.launch!);
      if (host) void run(root, host, false);
    },

    /** `GET /api/inbox/sessions`'s `launch` block: the agents To offers, the projects the folder menu lists. */
    async composeBlock(): Promise<InboxComposeLaunch | undefined> {
      if (!enabled()) return undefined;
      const root = scratchRoot();
      const offered = await Promise.all(
        hostList.map(async (host) => {
          const state = stateOf(host);
          // Not available last time: look again (the person may have just installed or updated it).
          const ok = await available(host, state.lastAvailable !== null && !state.lastAvailable.ok);
          state.lastAvailable = ok;
          // `scratch_trusted`: whether it starts in the scratch root without a trust prompt (the trust-once row).
          return ok.ok ? [{ agent: host.agent, name: host.name, scratch_trusted: host.trusts(root) }] : [];
        }),
      );
      const recency = new Map<string, string>();
      for (const row of store.listRows()) if ((recency.get(row.project.id) ?? "") < row.last_at) recency.set(row.project.id, row.last_at);
      // A scratch folder Delete removed is not offered again (it would only be listed struck through).
      const removed = new Set(roots().filter((root) => root.launch!.scratch && root.launch!.deleted_at).map((root) => root.launch!.folder));
      const projects = store
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, root: p.root, exists: isFolder(p.root) }))
        .filter((p) => p.exists || !removed.has(p.root))
        .sort((a, b) => (recency.get(b.id) ?? "").localeCompare(recency.get(a.id) ?? "") || a.name.localeCompare(b.name));
      return { agents: offered.flat(), projects, scratch: { root } };
    },

    /**
     * The thread route's `run`: waits for a host read when one is due. Null (no line) for an agent with no host here.
     * `owner`: the machine's owner reads it, so a line refused for trust carries the host's offer.
     */
    async runOf(threadId: string, owner: boolean = false): Promise<InboxRun | null | undefined> {
      if (!enabled()) return undefined;
      const root = store.message(threadId);
      if (!root?.launch || root.thread_id !== root.id) return undefined;
      const host = hostOf(root.launch);
      if (!host) return null;
      const state = stateOf(host);
      if (state.lastAvailable === null) state.lastAvailable = await available(host);
      if (hostStale(host) && needsHost(host, root)) await refreshHost(host);
      const line = runOfRoot(store.message(threadId)!);
      const offer = owner && line?.untrusted ? host.trustOffer?.(root.launch) : null;
      return offer ? { ...line!, trust: { warning: offer.warning } } : line;
    },

    /** A launched thread's attach command (the ⋯ menu's Copy, also while the agent rests and has no line), or null. */
    attachOf(threadId: string): string | null {
      const launch = store.message(threadId)?.launch;
      const host = launch ? hostOf(launch) : null;
      return host && launch!.session_ref && !launch!.deleted_at && !launch!.error ? host.attach(launch!) : null;
    },

    /** The list's row decorator, resolved once per list (one config read): the identity while launch is off. */
    rowDecorator(): <T extends InboxListRow>(row: T) => T {
      return enabled() ? (row) => this.decorateLaunched(row) : (row) => row;
    },

    /** A launched row with its run word, and a session blocked on a prompt placed in Stopped on you (through `rowDecorator`). */
    decorateLaunched<T extends InboxListRow>(row: T): T {
      const root = store.message(row.thread_id);
      if (!root?.launch) return row;
      const runLine = runOfRoot(root);
      if (runLine?.state === "waiting_terminal" && row.resolved_at === null) return { ...row, section: "stopped", unread: true, run: null };
      // A permission question waits on the person: the session is blocked on them (screen 09).
      if (runLine?.state === "waiting_answer" && row.resolved_at === null) return { ...row, section: "stopped", unread: true, run: null };
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
