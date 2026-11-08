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

import { checkNewHomeFolder, folderIdentity, isHomeItself, listHomeFolders, makeHomeFolder, resolveHomeFolder, sameFolderIdentity } from "./inbox-home-folders";
import { checkGitRemote, cloneTarget, defaultCloneFolder, originKeyOf, readLastCloneFolder, runGitClone, tildeOf, writeLastCloneFolder, type CloneRun } from "./inbox-launch-clone";
import { parseInboxGitUrl } from "@plannotator/core/inbox-git-url";
import { inboxLaunchNotReadyWords } from "@plannotator/core/inbox-launch-ready";
import { accessSync, appendFileSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { inboxId, type InboxComposeLaunch, type InboxLaunchAgent, type InboxLaunchFrom, type InboxLaunchRecord, type InboxLaunchTrust, type InboxLaunchUntrusted, type InboxListRow, type InboxMessage, type InboxProject, type InboxRun } from "@plannotator/core/inbox-types";
import { inboxLaunchedSession, inboxRunOf, INBOX_RUN_START_GRACE_MS, type InboxRunHostState } from "@plannotator/core/inbox-run-line";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { derivePersonThreadSubject } from "@plannotator/core/inbox-questions";
import { INBOX_SCRATCH_PICK, inboxScratchCandidate, inboxScratchSlug } from "@plannotator/core/inbox-scratch";
import { loadConfig, resolveInboxLaunch, saveConfig } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { createClaudeLaunchHost } from "./inbox-launch-claude";
import { createPiLaunchHost } from "./inbox-launch-pi";
import { launchPlainEnv, launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostPermissions, LaunchHostResult, LaunchLive, LaunchSessions, LaunchTrustOffer } from "./inbox-launch-host";
import { openPermissionSince } from "./inbox-launch-permission";
import { INBOX_CROSS_SITE_BODY, INBOX_MACHINE_WINDOW_ONLY_BODY, INBOX_WINDOW_ONLY_BODY, isCrossSiteRequest, isWindowRequest } from "./inbox-cross-site";
import { samePlace } from "./agent-files";

const AVAILABLE_TTL_MS = 30_000;
const HOST_TTL_MS = 10_000;

/**
 * Compose's `to.launch`: a project's folder, or a new scratch folder. `trust`: the person pressed Trust and start on
 * this reading of it; the press is the consent, so the Send saves the trust ("Trusting a folder").
 */
export type InboxLaunchTarget = (
  | { agent: InboxLaunchAgent; project_id: string }
  | { agent: InboxLaunchAgent; scratch: true }
  | { agent: InboxLaunchAgent; folder: string; create?: true; clone?: { url: string; branch?: string } }
) & {
  trust?: InboxLaunchTrust;
};

/** The reading a press was made on, or nothing when the press came without one. */
function trustOfTarget(value: Record<string, unknown>): { trust?: InboxLaunchTrust } {
  const trust = value.trust as { folder?: unknown; facts?: unknown } | null | undefined;
  if (trust === undefined) return {};
  const folder = trust?.folder;
  const facts = trust?.facts;
  if (typeof folder !== "string" || !Array.isArray(facts) || !facts.every((fact) => typeof fact === "string")) {
    throw new InboxError("validation_error", "to.launch.trust: { folder, facts }, the reading the person pressed on.", { field: "to.launch.trust" });
  }
  return { trust: { folder, facts } };
}

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
  /** Clone from a git URL: the reply that started the clone again last (once per reply, as a respawn). */
  cloneFor?: string | null;
  /** When the running clone began: its percent shows only after a few seconds (E2). */
  cloneStartedAt?: number;
}

/** The clone percent shows once a clone has run this long (E2: a big repo, not every clone). */
const CLONE_PCT_AFTER_MS = 3_000;
/** How long the quiet check's answer for a URL is kept (`clone-check`). */
const CLONE_REACH_KEEP_MS = 60_000;

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
  /** A tailnet request from someone other than this computer's owner: never starts, stops or deletes an agent (Try again, Stop, Delete). Absent: nobody is. */
  isGuest?: (req: Request, via: string) => boolean;
  /** This Inbox was started over SSH (`SSH_CONNECTION` at start): macOS keeps Claude Code's login locked there, so the launch block names that cause. */
  startedOverSsh?: boolean;
  /** This computer's name as linked machines know it: a launch another machine sends is refused in words that name it. */
  machineName?: () => string | null;
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
        // Only whether these are set (a sign-in token, a cloud provider's switch): never the value.
        for (const name of hostList.flatMap((host) => host.shellFlags ?? [])) if (login[name]) kept[name] = "1";
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
  /** A folder's identity (`<dev>:<ino>[:<birth>]`, `folderIdentity`), or null when it is not there. */
  const inodeOf = folderIdentity;
  /**
   * A scratch folder is still the one the Inbox made: a real folder named as a slug, with no symbolic link
   * anywhere on its path, so it is still right inside the root's real path it was made in (the record holds
   * that real path), and the same folder (`inode`, recorded when it was made), never one made at that path
   * since. Only then may Delete purge and remove it; anything else (a link swapped in, pointing out of the
   * root, another folder, or none) is left alone.
   */
  const scratchIntact = (folder: string, inode: string | undefined): boolean => {
    try {
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(basename(folder)) && lstatSync(folder).isDirectory() && realpathSync(folder) === folder && sameFolderIdentity(inodeOf(folder), inode);
    } catch {
      return false;
    }
  };
  /**
   * Create a folder, undone (a thread that was never written): the folder goes only while it is still the one the Send
   * made (no link swapped in, the same inode) and still empty, so nothing anyone put there is ever removed.
   */
  const removeMadeFolder = (folder: string, inode: string): void => {
    try {
      if (!lstatSync(folder).isDirectory() || realpathSync(folder) !== folder || !sameFolderIdentity(inodeOf(folder), inode)) return;
      rmdirSync(folder);
    } catch {
      // Not empty, or gone: left as it is.
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
    createPiLaunchHost(context),
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

  /** The root of a launched thread whose launch started this session, with launch on and the launch not deleted. */
  const launchedRootOf = (threadId: string, session: string | null | undefined): InboxMessage | null => {
    if (!enabled() || !session) return null;
    const root = store.message(threadId);
    if (!root?.launch || root.launch.deleted_at || inboxLaunchedSession(root) !== session) return null;
    return root;
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
      connector: host.connector,
      attachCommand: host.attach(launch),
      permissionSince: openPermissionSince(store, root.thread_id),
      ...(launch.made_folder || launch.clone ? { shownFolder: options.displayFolder(launch.folder) } : {}),
      ...(launch.clone?.state === "cloning"
        ? {
            cloneRunning: clones.has(launch.id) || starting.has(launch.id),
            clonePct: now() - (memo.cloneStartedAt ?? now()) >= CLONE_PCT_AFTER_MS ? (clones.get(launch.id)?.pct() ?? null) : null,
          }
        : {}),
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

  /**
   * Create a folder (q-d2512542): a folder the Send just made, still empty, is trusted as one the person trusted by
   * hand (the same store, through the host's offer), so the agent starts at once, with no Trust folder step. Only while
   * it is still that folder (a real folder at that path, the identity recorded when it was made) and still empty: a
   * folder with anything in it is read and trusted by the person, as any other.
   */
  const trustMadeFolder = async (launch: InboxLaunchRecord, host: LaunchHost): Promise<void> => {
    if (!launch.made_folder || !launch.made_inode || launch.scratch || host.trusts(launch.folder)) return;
    try {
      if (!lstatSync(launch.folder).isDirectory() || realpathSync(launch.folder) !== launch.folder || !sameFolderIdentity(inodeOf(launch.folder), launch.made_inode)) return;
      if (readdirSync(launch.folder).length > 0) return;
    } catch {
      return;
    }
    const offer = host.trustOffer?.({ folder: launch.folder, scratch: false });
    if (!offer) return;
    try {
      await offer.accept();
      log(`Inbox launch ${launch.id}: trusted ${launch.folder} (made by this Send, empty)`);
    } catch (error) {
      // Not saved: the start says it needs trust, with Trust folder, as before.
      startLog(launch.id, `made folder: trust not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

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
      await trustMadeFolder(launch, host);
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

  // ── Clone from a git URL (approval "launch-create-clone", E1-E11) ──

  /** The clones running now, by launch id: their percent for the line, and Cancel. */
  const clones = new Map<string, CloneRun>();
  /** The last percent the windows were told of, by launch: they hear again every 5 points, never on every line git writes. */
  const clonePctSaid = new Map<string, number>();

  /** What a cloned repo brings that the person trusts first (decision 4a): read from the trust reading's facts. */
  const bringsOf = (facts: readonly string[]): string[] => {
    const text = facts.join(" ");
    const brings: string[] = [];
    if (/\bhooks?\b/.test(text)) brings.push("hooks");
    if (/MCP server/.test(text)) brings.push("MCP servers");
    if (/helper command|env settings|without asking|outside folders|couldn't be read/.test(text)) brings.push("settings");
    return brings;
  };

  /**
   * Clone, then start (E1, E3): `git clone` into the folder the Send made, its percent on the line after a few seconds
   * (E2). Done: a repo that brings no hooks, MCP servers or settings is trusted and started without asking; one that
   * does waits for the person's trust (E10, decision 4a), as any untrusted folder's start does. Failed: the line says
   * why (E4-E6) and the message is kept; the folder the Send made goes, as on Cancel (E7).
   */
  const cloneThenRun = async (root: InboxMessage, host: LaunchHost): Promise<void> => {
    const launch = root.launch!;
    const clone = launch.clone!;
    const memo = memoOf(launch);
    memo.startedAt = now();
    memo.cloneStartedAt = now();
    clonePctSaid.delete(launch.id);
    starting.add(launch.id);
    let started = false;
    // Cancel and Delete find this run from the first moment (the line shows Cancel at once), not only once git runs:
    // pressed while the login shell is read, git is never started.
    type CloneResult = Awaited<CloneRun["done"]>;
    let git: CloneRun | null = null;
    let calledOff = false;
    let settle!: (result: CloneResult) => void;
    const handle: CloneRun = {
      done: new Promise<CloneResult>((resolveDone) => (settle = resolveDone)),
      pct: () => git?.pct() ?? null,
      cancel: () => {
        calledOff = true;
        if (git) git.cancel();
        else settle({ ok: false, error: "failed", text: "", cancelled: true });
      },
    };
    clones.set(launch.id, handle);
    options.onChange();
    try {
      // A Cancel during the shell read ends the wait too: the line says cancelled at once.
      const shellRead = await Promise.race([readLogin(), handle.done.then(() => null)]);
      if (shellRead && !calledOff && !store.message(root.id)?.launch?.deleted_at) {
        const login = launchSpawnEnv(shellRead);
        git = runGitClone({
          url: clone.url,
          ...(clone.branch ? { branch: clone.branch } : {}),
          folder: launch.folder,
          env: login,
          onProgress: (pct) => {
            const said = clonePctSaid.get(launch.id) ?? -100;
            if (pct - said >= 5 || pct === 100) {
              clonePctSaid.set(launch.id, pct);
              options.onChange();
            }
          },
        });
        git.done.then(settle);
      } else settle({ ok: false, error: "failed", text: "", cancelled: true });
      const result = await handle.done;
      if (clones.get(launch.id) === handle) clones.delete(launch.id);
      const current = store.message(root.id);
      if (!current?.launch || current.launch.deleted_at) return;
      const ended_at = new Date(now()).toISOString();
      if (!result.ok) {
        // The folder the Send made goes (while it is still that folder), and its identity with it: a folder made at
        // that path later is never taken for the Inbox's.
        const removed = removeClonedFolder(current.launch);
        if (result.cancelled) {
          // E7: nothing is kept on that machine.
          store.settleLaunch(root.id, { clone: { ...clone, state: "cancelled", ended_at }, ...(removed ? { made_inode: null } : {}) });
        } else {
          // E4-E6: git leaves the folder empty; it goes too, so Try again or a changed URL clones into that name again.
          startLog(launch.id, `clone ${clone.url}: ${result.error}
${result.text}`);
          store.settleLaunch(root.id, {
            clone: { ...clone, state: "failed", error: result.error, ...(result.error === "failed" && result.text ? { error_text: result.text.slice(0, 300) } : {}), ended_at },
            ...(removed ? { made_inode: null } : {}),
          });
        }
        log(`Inbox launch ${launch.id}: clone ${result.cancelled ? "cancelled" : `failed (${result.error})`}`);
        return;
      }
      // Done. What it brings decides whether it starts without asking (decision 4a).
      let brings: string[] = [];
      if (!host.trusts(launch.folder)) {
        const offer = host.trustOffer?.({ folder: launch.folder, scratch: false }) ?? null;
        if (offer) {
          const reading = offer.read();
          if (reading.warns) brings = bringsOf(reading.facts);
          else {
            try {
              await offer.accept();
            } catch (error) {
              startLog(launch.id, `clone: trust not saved: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
      const settled = store.settleLaunch(root.id, { clone: { ...clone, state: "done", ...(brings.length > 0 ? { brings } : {}) } });
      log(`Inbox launch ${launch.id}: cloned ${clone.slug}`);
      starting.delete(launch.id);
      started = true;
      await run(settled, host, false);
    } catch (error) {
      if (clones.get(launch.id) === handle) clones.delete(launch.id);
      const text = error instanceof Error ? error.message : String(error);
      startLog(launch.id, `clone error: ${text}`);
      if (store.message(root.id)?.launch && !store.message(root.id)!.launch!.deleted_at) {
        const removed = removeClonedFolder(store.message(root.id)!.launch!);
        store.settleLaunch(root.id, { clone: { ...clone, state: "failed", error: "failed", error_text: text.slice(0, 300), ended_at: new Date(now()).toISOString() }, ...(removed ? { made_inode: null } : {}) });
      }
    } finally {
      if (!started) {
        starting.delete(launch.id);
        stateOf(host).view = null;
        options.onChange();
      }
    }
  };

  /**
   * Cancel, Delete or a failed clone: the partly cloned folder goes while it is still the one the Send made (E7): a
   * real folder at that path, with the identity (inode and birth time) recorded when the Inbox made it. True when the
   * record should drop that identity: the folder is removed or gone, or what is there now isn't the Inbox's.
   */
  const removeClonedFolder = (launch: InboxLaunchRecord): boolean => {
    if (!launch.made_folder || !launch.made_inode) return false;
    try {
      if (!lstatSync(launch.folder).isDirectory() || realpathSync(launch.folder) !== launch.folder || !sameFolderIdentity(inodeOf(launch.folder), launch.made_inode)) return true;
      rmSync(launch.folder, { recursive: true, force: true });
      return true;
    } catch {
      // Gone already.
      return true;
    }
  };

  /**
   * Try again, Clone again or a reply after a failed or cancelled clone: the folder made again (empty), and the clone
   * run again. A folder at that path now that the Inbox didn't make (the person's own) is cloned into as it is, and
   * never removed: the record holds no identity for it.
   */
  const cloneAgain = (root: InboxMessage, host: LaunchHost): void => {
    const launch = root.launch!;
    // A partly cloned folder of the Inbox's left there (a restart cut its clone off): it goes first, so git gets an empty one.
    removeClonedFolder(launch);
    let madeInode: string | null = null;
    if (!isFolder(launch.folder)) {
      try {
        mkdirSync(launch.folder);
      } catch (error) {
        throw new InboxError("folder_unavailable", `${options.displayFolder(launch.folder)} can't be made again: ${error instanceof Error ? error.message : String(error)}`);
      }
      madeInode = inodeOf(launch.folder);
    }
    const { error: _error, error_text: _text, ended_at: _ended, ...clone } = launch.clone!;
    const settled = store.settleLaunch(root.id, { clone: { ...clone, state: "cloning" }, made_inode: madeInode });
    void cloneThenRun(settled, host);
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
    // A clone that failed or was cancelled: the person's reply clones again (E7: "Your reply starts it again"), once per reply.
    if (host && !launch.deleted_at && launch.clone && (launch.clone.state === "failed" || launch.clone.state === "cancelled") && root.to && !starting.has(launch.id)) {
      const memo = memoOf(launch);
      // A reply the person wrote after the clone ended: never the thread's own first message (it waits for the agent
      // too), nor one the clone already had (E7: Cancel stays cancelled, a failure stays failed, a restart included).
      const ended = launch.clone.ended_at ?? null;
      const newest = store
        .pendingReplies(root.to.session, { tags: true })
        .filter((reply) => !reply.by_guest && reply.id !== root.id && ended !== null && reply.created_at > ended)
        .at(-1);
      if (newest && memo.cloneFor !== newest.id) {
        memo.cloneFor = newest.id;
        try {
          cloneAgain(root, host);
        } catch (error) {
          log(`Inbox launch ${launch.id}: a reply's clone did not start: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }
    if (!host || launch.deleted_at || launch.error || !launch.session_ref || !root.to || respawning.has(launch.id) || starting.has(launch.id)) return;
    // Only a session that connected once: one that never did is "not connected", and respawning it would not help.
    // A host that owns the process is the exception once that process ended (its line says a reply continues it).
    if (!root.delivery && host.processEnded?.(launch.session_ref) !== true) return;
    // A Stop or a Delete under way: the session is going, never started again meanwhile (a host's `live` may
    // read null as soon as its stop begins).
    if (stopping.has(launch.id) || deleting.has(launch.id)) return;
    const memo = memoOf(launch);
    if (liveOf(host, root, memo)) return;
    if (now() - memo.startedAt < INBOX_RUN_START_GRACE_MS) return;
    // A tailnet guest's reply waits for the session as any reply does; only the owner's (or this computer's) starts it again.
    const newest = store
      .pendingReplies(root.to.session, { tags: true })
      .filter((reply) => !reply.by_guest)
      .at(-1);
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
  /**
   * "Another folder on <machine>…": the folder names in one folder under home (`listHomeFolders`). The owner's window
   * only: a guest gets `owner_only`; an agent's call, MCP and the CLI (no same-origin fetch) and a linked machine
   * without the window's mark get `window_only`; a phone's door never reaches it (a machine-only door route).
   */
  const homeFolders = (req: Request, via: string, owner: boolean, door: { platform: string; window: boolean } | null): Response => {
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    if (!owner || options.isGuest?.(req, via)) return json({ error: "Only this computer's owner can list its folders.", code: "owner_only" }, 403);
    const window = door ? door.window : req.headers.get("sec-fetch-site") === "same-origin";
    if (!window) return json({ error: "Folders are listed in the Inbox window only.", code: "window_only" }, 403);
    const listed = listHomeFolders(options.homeDir, new URL(req.url).searchParams.get("path") ?? "~");
    if ("refused" in listed) {
      return json(listed.refused === "hidden" ? { error: "Hidden folders aren't listed.", code: "folder_hidden" } : { error: "Only folders inside the home folder.", code: "folder_outside_home" }, 422);
    }
    return json(listed);
  };

  /** The folder reads' guard (`homeFolders`): the owner's window only, here or through a linked machine's forward. */
  const windowRead = (req: Request, via: string, owner: boolean, door: { platform: string; window: boolean } | null): Response | null => {
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    if (!owner || options.isGuest?.(req, via)) return json({ error: "Only this computer's owner can read this.", code: "owner_only" }, 403);
    const window = door ? door.window : req.headers.get("sec-fetch-site") === "same-origin";
    if (!window) return json({ error: "Folders are read in the Inbox window only.", code: "window_only" }, 403);
    return null;
  };

  /** Where a clone goes on this machine with no setting (C1, C1b, C1c). */
  const defaultCloneInto = (): string =>
    defaultCloneFolder({
      home: realOrSelf(options.homeDir),
      last: readLastCloneFolder(options.dataDir),
      projectRoots: store.listProjects().map((p) => p.root),
      isFolder,
    });

  /**
   * Clone from a git URL: where `url` would be cloned on this machine (`GET /api/inbox/launch/clone?url=…&into=~/…`).
   * `into` absent: the default clone folder. Answers `{ into, path, name, state: "clone" | "already", taken, writable }`,
   * each path as `~/…`; a URL that isn't a repo `422 validation_error`, a folder the listing refuses its `422`.
   */
  const cloneTargetRoute = (req: Request, via: string, owner: boolean, door: { platform: string; window: boolean } | null): Response => {
    const refused = windowRead(req, via, owner, door);
    if (refused) return refused;
    const query = new URL(req.url).searchParams;
    const repo = parseInboxGitUrl(query.get("url") ?? "");
    if (!repo || repo.kind !== "repo") return json({ error: "Not a git repo's URL.", code: "validation_error" }, 422);
    const home = realOrSelf(options.homeDir);
    const typedInto = query.get("into");
    let into: string;
    if (typedInto) {
      const at = resolveHomeFolder(options.homeDir, typedInto);
      if (!at.ok) return json(at.refused === "hidden" ? { error: "Hidden folders aren't listed.", code: "folder_hidden" } : { error: "Only folders inside the home folder.", code: "folder_outside_home" }, 422);
      if (!at.exists || !at.real) return json({ error: `${at.shown} isn't there.`, code: "folder_missing" }, 422);
      into = at.real;
    } else into = defaultCloneInto();
    const key = `${repo.host}/${repo.slug}`.toLowerCase();
    // The folder named is itself a clone of that repo (C9): it starts there.
    const target = originKeyOf(into) === key ? { path: into, name: basename(into), state: "already" as const, taken: null } : cloneTarget({ into, repo: repo.repo, key, exists: existsSync, originOf: originKeyOf });
    if (!target) return json({ error: `Every name for ${repo.repo} is taken in ${tildeOf(home, into)}.`, code: "folder_unavailable" }, 422);
    let writable = true;
    try {
      accessSync(into, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      writable = false;
    }
    return json({ into: tildeOf(home, into), path: tildeOf(home, target.path), name: target.name, state: target.state, taken: target.taken ? tildeOf(home, target.taken) : null, writable });
  };

  /** The quiet check after a paste (`GET /api/inbox/launch/clone-check?url=…`): `{ reach: "ok" | "auth" | "not_found" | "network" | "failed" }`, from this machine's git. */
  const cloneCheck = async (req: Request, via: string, owner: boolean, door: { platform: string; window: boolean } | null): Promise<Response> => {
    const refused = windowRead(req, via, owner, door);
    if (refused) return refused;
    const repo = parseInboxGitUrl(new URL(req.url).searchParams.get("url") ?? "");
    if (!repo || repo.kind !== "repo") return json({ error: "Not a git repo's URL.", code: "validation_error" }, 422);
    // Asked a moment ago (another window, the same URL typed again): that answer, with no git run.
    const known = reachKnown.get(repo.url);
    if (known && now() - known.at < CLONE_REACH_KEEP_MS) return json({ reach: known.reach });
    // The Inbox's own env, with the login PATH after it: no login shell is read for a check. A window that stopped
    // asking (it typed on) ends git at once.
    const env = launchPlainEnv(options.ownEnv(), loginPath);
    const reach = await checkGitRemote({ url: repo.url, env, signal: req.signal });
    if (req.signal.aborted) return json({ reach: "failed" });
    reachKnown.delete(repo.url);
    reachKnown.set(repo.url, { at: now(), reach });
    if (reachKnown.size > 64) reachKnown.delete(reachKnown.keys().next().value!);
    return json({ reach });
  };
  /** The quiet check's answers by URL, for a minute: typing on, or a second window, asks git once. */
  const reachKnown = new Map<string, { at: number; reach: Awaited<ReturnType<typeof checkGitRemote>> }>();

  /**
   * `owner`: the machine's owner, here or over the tailnet (a guest the allow list let in is not). `door`: the request
   * came through the device door (a linked machine's Stop, Try again, Trust folder or Delete; remote launch). A
   * machine is the owner's, and acts only for a press in a window there (`window`), never for an agent's bare call.
   */
  const route = async (
    req: Request,
    path: string,
    via: "local" | "tailnet" | string,
    owner: boolean = via === "local",
    door: { platform: string; window: boolean } | null = null,
  ): Promise<Response | null> => {
    if (path === "/api/inbox/launch/folders") {
      if (!enabled()) return json({ error: "Launch is off.", code: "launch_off" }, 404);
      return homeFolders(req, via, owner, door);
    }
    if (path === "/api/inbox/launch/clone" || path === "/api/inbox/launch/clone-check") {
      if (!enabled()) return json({ error: "Launch is off.", code: "launch_off" }, 404);
      return path.endsWith("check") ? await cloneCheck(req, via, owner, door) : cloneTargetRoute(req, via, owner, door);
    }
    const match = /^\/api\/inbox\/launch\/(settings|lch_[0-9A-HJKMNP-TV-Z]{26})(?:\/(stop|open|delete|retry|trust))?$/.exec(path);
    if (!match) return null;
    if (!enabled()) return json({ error: "Launch is off.", code: "launch_off" }, 404);
    // Settings → Agents, shown: the switch as it stands; never set, the login shell read again when stale.
    if (req.method === "GET" && match[1] === "settings" && !match[2]) {
      // The owner's, from this computer or over the tailnet (their phone); never a guest's.
      if (options.isGuest?.(req, via)) return json({ error: "Only this computer's owner can read this.", code: "owner_only" }, 403);
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
      // The owner's, from this computer or over the tailnet (their phone), as main's other settings are; never a guest's.
      if (options.isGuest?.(req, via)) return json({ error: "Only this computer's owner can change this.", code: "owner_only" }, 403);
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
    // From another machine: only what a person pressed in a window there (its Inbox checked; this door trusts its token).
    if (door && !door.window) return json(INBOX_MACHINE_WINDOW_ONLY_BODY, 403);
    switch (match[2]) {
      case "stop": {
        // Stop ends the owner's agent: never a guest's to do, as starting one isn't.
        if (options.isGuest?.(req, via)) throw new InboxError("owner_only", "Only this computer's owner can stop an agent from this Inbox.");
        // Cancel during a clone (E1, E7): git is stopped, and the partly cloned folder goes.
        const cloning = clones.get(launch.id);
        if (cloning) {
          cloning.cancel();
          await cloning.done;
          // Its own end settles the record; wait for that, so the answer is the cancelled line.
          for (let i = 0; i < 50 && store.message(root.id)?.launch?.clone?.state === "cloning"; i++) await new Promise((r) => setTimeout(r, 20));
          return json({ run: runOfRoot(store.message(root.id)!) });
        }
        // A clone a restart cut off (no git runs for it now): Cancel still ends it, and its partly cloned folder goes.
        if (launch.clone?.state === "cloning") {
          const removed = removeClonedFolder(launch);
          store.settleLaunch(root.id, { clone: { ...launch.clone, state: "cancelled", ended_at: new Date(now()).toISOString() }, ...(removed ? { made_inode: null } : {}) });
          options.onChange();
          return json({ run: runOfRoot(store.message(root.id)!) });
        }
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
        const e = await environment();
        // osascript is what decides, not the platform, so the e2e specs' fake runs on a Linux CI runner too. Asked
        // first: `terminal` may hand a session over, and a refused Open must change nothing.
        const osascript = e.which("osascript");
        if (!osascript) throw new InboxError("open_unavailable", options.platform === "darwin" ? "osascript is not on PATH; copy the command instead." : "Open in Terminal is for macOS; copy the command instead.");
        // A start or restart the agent refused for trust: the host's command where trust is accepted.
        const untrusted = !!launch.error || respawnUntrustedOf(memoOf(launch));
        const command = host.terminal(launch, untrusted);
        // `on run argv`: the command is an argument, never part of the script's text.
        const script = ["on run argv", 'tell application "Terminal"', "activate", "do script (item 1 of argv)", "end tell", "end run"];
        const result = await e.run([osascript, ...script.flatMap((line) => ["-e", line]), command], { timeoutMs: 15_000 });
        if (result.exitCode !== 0) host.terminalFailed?.(launch, command);
        if (result.exitCode !== 0) throw new InboxError("open_unavailable", `Terminal did not open: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
        return json({ ok: true, command });
      }
      case "delete": {
        // Delete stops and removes the owner's agent: never a guest's to do.
        if (options.isGuest?.(req, via)) throw new InboxError("owner_only", "Only this computer's owner can delete an agent from this Inbox.");
        // A Delete under way (a double click): the same answer, once it is done.
        const under = deleting.get(launch.id);
        if (under) return json(await under);
        // Deleted already (a second Delete, from a stale window): nothing more. Its folder path may be another launch's now.
        if (launch.deleted_at) return json({ ok: true });
        const done = (async (): Promise<Record<string, unknown>> => {
          // Still cloning: the clone is called off and its folder goes (the record says deleted first, so it stays so).
          const cloning = clones.get(launch.id);
          if (cloning) {
            store.settleLaunch(root.id, { deleted_at: new Date(now()).toISOString() });
            cloning.cancel();
            await cloning.done;
            removeClonedFolder(launch);
          } else if (launch.clone?.state === "cloning") removeClonedFolder(launch);
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
        // Try again starts the agent: the owner's, as a Send that starts one is (inbox-compose.ts).
        if (options.isGuest?.(req, via)) throw new InboxError("owner_only", "Only this computer's owner can start an agent from this Inbox.");
        if (starting.has(launch.id) || respawning.has(launch.id) || trusting.has(launch.id)) throw new InboxError("validation_error", "It is starting already.");
        // A clone that failed or was cancelled (or cut off by a restart): clone again, then start.
        if (launch.clone && (launch.clone.state === "failed" || launch.clone.state === "cancelled" || (launch.clone.state === "cloning" && !clones.has(launch.id)))) {
          cloneAgain(root, host);
          return json({ run: runOfRoot(store.message(root.id)!) });
        }
        if (!isFolder(launch.folder)) throw new InboxError("folder_missing", `${options.displayFolder(launch.folder)} isn't there any more.`);
        tryAgain(root, host);
        return json({ run: runOfRoot(store.message(root.id)!) });
      }
      case "trust": {
        if (!owner) throw new InboxError("owner_only", "Only this computer's owner can trust a folder.");
        if (!door?.window && !isWindowRequest(req, body, options.serverSession)) return json(INBOX_WINDOW_ONLY_BODY, 403);
        // A click under way (a double click): the same answer, once it is done.
        const under = trusting.get(launch.id);
        if (under) return json(await under);
        const done = (async (): Promise<Record<string, unknown>> => {
          const runNow = () => ({ run: runOfRoot(store.message(root.id)!) });
          // Nothing refused now (a second click, a stale window): the line as it stands, never a second start.
          if (!refusedForTrust(root)) return runNow();
          if (!isFolder(launch.folder)) throw new InboxError("folder_missing", `${options.displayFolder(launch.folder)} isn't there any more.`);
          const offer = trustOfferOf(host, launch);
          // The person agreed to the line they read: a folder that changed since gets a new read, and a new click.
          const { warning } = offer.read();
          if ((body.warning ?? null) !== warning) throw new InboxError("trust_warning_changed", `This folder changed, so nothing was saved. ${warning ?? "It no longer has anything to warn about."} Click Trust folder again if that's fine.`);
          await saveTrust(offer);
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

  /** A press that needs an offer, on a folder that has none now: nothing is saved. */
  const trustOfferOf = (host: LaunchHost, target: { folder: string; scratch: boolean }): LaunchTrustOffer => {
    const offer = host.trustOffer?.(target);
    if (!offer) throw new InboxError("trust_failed", `${host.name} can't trust this folder from here.`);
    return offer;
  };
  const saveTrust = async (offer: LaunchTrustOffer, allowed?: () => boolean): Promise<void> => {
    try {
      await offer.accept(allowed);
    } catch (error) {
      throw new InboxError("trust_failed", error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * The trust a Send has to save, from the reading it was pressed on: the offer compared, so what is saved is what
   * was compared. A folder that changed since the reading saves and sends nothing (`trust_warning_changed`: the window
   * reads it again and opens the details). A folder trusted since has nothing to save. Reads the folder's files now, so
   * a scratch root is read before anything is made.
   */
  const pressedTrust = (host: LaunchHost, folder: string, reading: InboxLaunchTrust | undefined): LaunchTrustOffer | null => {
    if (!reading || host.trusts(folder)) return null;
    const offer = trustOfferOf(host, { folder, scratch: false });
    const { facts } = offer.read();
    const same = offer.folder === reading.folder && facts.length === reading.facts.length && facts.every((fact, i) => fact === reading.facts[i]);
    if (!same) throw new InboxError("trust_warning_changed", "This folder changed. Nothing was trusted or sent.");
    return offer;
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

  const realOrSelf = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
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
      if (host && value!.scratch === true && value!.project_id === undefined) return { agent: host.agent, scratch: true, ...trustOfTarget(value!) };
      // "Another folder on <machine>…": a folder under home that is not a project yet (`~/…`).
      // `create: true` (Create a folder): its last folder may not be there yet; the Send makes it.
      if (host && typeof value!.folder === "string" && value!.project_id === undefined && value!.scratch === undefined) {
        // `clone` (Clone from a git URL): `{ url, branch? }`, the URL checked again here; the folder is where it goes.
        const clone = value!.clone as { url?: unknown; branch?: unknown } | undefined;
        if (clone !== undefined) {
          const repo = clone && typeof clone === "object" && typeof clone.url === "string" ? parseInboxGitUrl(clone.url) : null;
          if (!repo || repo.kind !== "repo" || (clone.branch !== undefined && (typeof clone.branch !== "string" || clone.branch.startsWith("-") || !/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(clone.branch)))) {
            throw new InboxError("validation_error", "to.launch.clone: { url: an https or ssh git URL, branch? }.", { field: "to.launch.clone" });
          }
          return { agent: host.agent, folder: value!.folder, clone: { url: clone.url as string, ...(typeof clone.branch === "string" ? { branch: clone.branch } : {}) }, ...trustOfTarget(value!) };
        }
        return { agent: host.agent, folder: value!.folder, ...(value!.create === true ? { create: true as const } : {}), ...trustOfTarget(value!) };
      }
      if (!host || typeof value!.project_id !== "string") {
        const agent = hostList.map((h) => `"${h.agent}"`).join(" | ");
        throw new InboxError("validation_error", `to.launch: { agent: ${agent}, project_id }, { agent: ${agent}, folder } or { agent: ${agent}, scratch: true }.`, { field: "to.launch" });
      }
      return { agent: host.agent, project_id: value!.project_id, ...trustOfTarget(value!) };
    },

    /**
     * Check before anything is written: the folder is there, the agent can start, and a press of Trust and start was
     * made on the folder as it is now (`trust`: the Send has a trust to save, with `acceptTrust`, once every check
     * passed). A scratch launch makes its folder last (after those checks), named from the thread's name (`name`,
     * else the subject of `body`), and `resolveProject` makes it a project as usual; `abandon` removes it when the
     * thread is then not written.
     */
    async prepare(
      target: InboxLaunchTarget,
      input: { name: string | null; body: string; resolveProject: (path: string) => Promise<InboxProject>; from?: InboxLaunchFrom | null },
    ): Promise<{ project: InboxProject; to: { host: string; session: string }; launch: InboxLaunchRecord; trust: LaunchTrustOffer | null }> {
      const host = Object.hasOwn(hosts, target.agent) ? hosts[target.agent]! : null;
      if (!host) throw new InboxError("agent_unavailable", `${target.agent} can't be started here. Nothing was sent.`);
      // A folder under home (not a project yet): by the folder listing's rules; it becomes a project below.
      const typed = "folder" in target ? resolveHomeFolder(options.homeDir, target.folder) : null;
      // Home itself is listed, never started in: an agent there reaches every folder under it, hidden ones too.
      if (typed && (!typed.ok || (typed.real && isHomeItself(options.homeDir, typed.real)))) {
        throw new InboxError("validation_error", typed.ok === false && typed.refused === "hidden" ? "Hidden folders can't be picked. Nothing was sent." : "Pick a folder inside the home folder. Nothing was sent.", { field: "to.launch" });
      }
      // Clone from a git URL: the folder named is where the clone goes. The same repo there already is started in as it
      // is (C9); a name taken by anything else since the pick moves to the next free one, and the line says so (E11).
      const cloneOf = "folder" in target && target.clone ? (parseInboxGitUrl(target.clone.url) as import("@plannotator/core/inbox-git-url").InboxGitRepo) : null;
      let cloneRenamedFrom: string | null = null;
      let cloneFolder = "folder" in target ? target.folder : null;
      if (cloneOf && typed?.ok && typed.state !== "missing") {
        const key = `${cloneOf.host}/${cloneOf.slug}`.toLowerCase();
        if (!(typed.state === "folder" && typed.real && originKeyOf(typed.real) === key)) {
          const segments = typed.shown.split("/");
          const parentShown = segments.slice(0, -1).join("/") || "~";
          const parent = resolveHomeFolder(options.homeDir, parentShown);
          const free = parent.ok && parent.real ? cloneTarget({ into: parent.real, repo: segments[segments.length - 1]!, key, exists: existsSync, originOf: originKeyOf }) : null;
          if (!free) throw new InboxError("folder_unavailable", `${typed.shown} is taken. Pick another folder. Nothing was sent.`, { field: "to.launch" });
          cloneRenamedFrom = typed.shown;
          cloneFolder = tildeOf(realOrSelf(options.homeDir), free.path);
        }
      }
      const cloneTyped = cloneOf && cloneFolder !== null && cloneRenamedFrom ? resolveHomeFolder(options.homeDir, cloneFolder) : null;
      if (cloneTyped && !cloneTyped.ok) throw new InboxError("validation_error", "Pick a folder inside the home folder. Nothing was sent.", { field: "to.launch" });
      const pathTyped = (cloneTyped ?? typed) as Extract<NonNullable<typeof typed>, { ok: true }> | null;
      const cloning = !!cloneOf && pathTyped?.ok === true && pathTyped.state !== "folder";
      // Create a folder (`create`), or a clone's folder: a path whose last folder isn't there is checked now and made last, after every check.
      const creating =
        pathTyped?.ok && pathTyped.state !== "folder" && "folder" in target && (target.create === true || cloning) ? checkNewHomeFolder(options.homeDir, cloneFolder ?? target.folder) : null;
      if (creating && !creating.ok) throw new InboxError(creating.code, creating.message, { field: "to.launch" });
      if (pathTyped?.ok && pathTyped.state === "locked") throw new InboxError("folder_unavailable", `Can't open ${pathTyped.shown}: no permission. Nothing was sent.`, { field: "to.launch" });
      if (pathTyped && !creating && (!pathTyped.exists || !pathTyped.real)) throw new InboxError("folder_missing", `${pathTyped.shown} isn't there. Pick another folder. Nothing was sent.`, { field: "to.launch" });
      const toMake = creating?.ok && creating.real === null ? creating : null;
      let folderTarget = pathTyped?.ok && pathTyped.real ? pathTyped.real : null;
      const chosen = "project_id" in target ? store.project(target.project_id) : folderTarget ? (store.listProjects().find((p) => p.root === folderTarget) ?? null) : null;
      if ("project_id" in target && !chosen) throw new InboxError("project_not_found", `No project ${target.project_id}.`);
      if (chosen && !isFolder(chosen.root)) {
        throw new InboxError("folder_missing", `${options.displayFolder(chosen.root)} isn't there any more. Pick another project. Nothing was sent.`, { field: "to.launch" });
      }
      const ok = await available(host, true);
      stateOf(host).lastAvailable = ok;
      if (!ok.ok) {
        // Sent from another machine: say it with this machine's name, as that machine's start row does.
        const machine = input.from ? (options.machineName?.() ?? null) : null;
        if (machine && ok.code) {
          const overSsh = ok.code === "signed_out" && options.startedOverSsh === true;
          const words = inboxLaunchNotReadyWords({ agent: host.name, code: ok.code, machine, overSsh });
          throw new InboxError("agent_unavailable", `${words.line}.${words.fix ? ` ${words.fix}` : ""} Nothing was sent.`, {
            not_ready: ok.code,
            ...(overSsh ? { over_ssh: true } : {}),
            ...(words.command ? { command: words.command } : {}),
          });
        }
        throw new InboxError("agent_unavailable", `${host.name} can't be started here: ${ok.reason}. Nothing was sent.`);
      }
      const id = inboxId("lch");
      // How it starts, fixed for this launch (the host's `startOf`: for Claude Code the switch, the person's own
      // setup with this folder's settings, and the last finished shell read, however old; the start reads the
      // shell again for its own env). Send waits on the shell only to finish a read already under way (the
      // composer's read ahead, or another launch's start), or when no read ever finished (`warm` reads one at
      // Inbox start).
      if (reading || shell === null) await readLogin();
      // After the shell read (it says where the agent's own files are), and before a scratch folder is made. A folder
      // still to be made has nothing in it to trust or read: plain Send.
      const trust = toMake ? null : pressedTrust(host, chosen ? chosen.root : (folderTarget ?? scratchRoot()), target.trust);
      // Create a folder: made now, after every check (one level, never its parents).
      let createdFolder: { real: string; made: boolean; inode: string } | null = null;
      if (toMake) {
        try {
          createdFolder = makeHomeFolder(toMake.parent, toMake.name);
        } catch {
          throw new InboxError("folder_unavailable", `Can't make ${toMake.shown}. Nothing was sent.`, { field: "to.launch" });
        }
        // A clone goes only into a folder this Send made: one made there since the checks (a second Send of the same
        // URL, from another window) is that clone's, and two gits never share a folder.
        if (cloneOf && !createdFolder.made) throw new InboxError("folder_unavailable", `${toMake.shown} was just made by another start. Pick the folder again. Nothing was sent.`, { field: "to.launch" });
        folderTarget = createdFolder.real;
      }
      const made = chosen || folderTarget ? null : makeScratch(input.name?.trim() || derivePersonThreadSubject(input.body));
      const folder = made ? made.folder : chosen ? chosen.root : folderTarget!;
      let project: InboxProject;
      try {
        project = chosen ?? (await input.resolveProject(folder));
      } catch (error) {
        if (made) rmSync(folder, { recursive: true, force: true });
        if (createdFolder?.made) removeMadeFolder(createdFolder.real, createdFolder.inode);
        throw error;
      }
      const start = host.startOf(folder);
      const launch: InboxLaunchRecord = {
        id,
        agent: host.agent,
        session_ref: null,
        folder,
        scratch: !!made,
        ...(made ? { scratch_inode: made.inode } : {}),
        // Create a folder: the Send made it (the failed line says it stays; a thread never written removes it again).
        ...(createdFolder?.made ? { made_folder: true as const, made_inode: createdFolder.inode } : {}),
        // Clone from a git URL: cloned into the folder just made, before the agent starts.
        ...(cloneOf && createdFolder
          ? {
              clone: {
                url: cloneOf.url,
                host: cloneOf.host,
                slug: cloneOf.slug,
                ...("folder" in target && target.clone?.branch ? { branch: target.clone.branch } : {}),
                state: "cloning" as const,
                ...(cloneRenamedFrom ? { renamed_from: cloneRenamedFrom } : {}),
              },
            }
          : {}),
        started_at: new Date(now()).toISOString(),
        ...(start.full ? { full_permissions: true } : {}),
        ...(start.ownMode ? { own_mode: true } : {}),
        ...(start.bypass ? { bypass_available: true } : {}),
        ...(input.from ? { from: { machine: input.from.machine, name: input.from.name } } : {}),
      };
      // C1c: the next clone on this machine goes where this one went.
      if (launch.clone) {
        try {
          writeLastCloneFolder(options.dataDir, dirname(folder));
        } catch {
          // Only a default: the next clone offers the projects' folder instead.
        }
      }
      return { project, to: { host: host.agent, session: `launch:${id}` }, launch, trust };
    },

    /**
     * Trust and start: saves `prepare`'s `trust`, after every check and before the thread is written, so `trust_failed`
     * sends nothing. `allowed`: the checks that can go stale during the host's lock wait, asked again once it holds it.
     */
    acceptTrust: saveTrust,

    /**
     * The thread was not written after `prepare` (a failed write, or a replay that landed meanwhile): the scratch
     * folder it made goes, and the project made for it while no thread is in it.
     */
    abandon(launch: InboxLaunchRecord, project: InboxProject): void {
      // Create a folder: the folder this Send made goes again while it is the same one and still empty.
      if (launch.made_folder && launch.made_inode) {
        removeMadeFolder(launch.folder, launch.made_inode);
        if (project.root === launch.folder && store.project(project.id) && store.listRows({ projectId: project.id }).length === 0) store.deleteProject(project.id);
        return;
      }
      if (!launch.scratch) return;
      if (scratchIntact(launch.folder, launch.scratch_inode)) rmSync(launch.folder, { recursive: true, force: true });
      if (project.root === launch.folder && store.project(project.id) && store.listRows({ projectId: project.id }).length === 0) store.deleteProject(project.id);
    },

    /** The thread is written: start the agent in the background. */
    begin(root: InboxMessage): void {
      const host = hostOf(root.launch!);
      if (!host) return;
      if (root.launch!.clone?.state === "cloning") void cloneThenRun(root, host);
      else void run(root, host, false);
    },

    /**
     * `GET /api/inbox/sessions`'s `launch` block: the agents To offers, the projects the folder menu lists.
     * `owner`: the owner's window asks, so each agent says which folders it would Trust and start. That read is
     * cheap (the host's cached `trusts`); only `owner.pick`, the folder picked in To, has its files read.
     */
    async composeBlock(owner: { pick: { agent: string; project: string } | null } | null = null): Promise<InboxComposeLaunch | undefined> {
      if (!enabled()) return undefined;
      const root = scratchRoot();
      const recency = new Map<string, string>();
      for (const row of store.listRows()) if ((recency.get(row.project.id) ?? "") < row.last_at) recency.set(row.project.id, row.last_at);
      // A scratch folder Delete removed is not offered again (it would only be listed struck through).
      const removed = new Set(roots().filter((root) => root.launch!.scratch && root.launch!.deleted_at).map((root) => root.launch!.folder));
      const projects = store
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, root: p.root, exists: isFolder(p.root) }))
        .filter((p) => p.exists || !removed.has(p.root))
        .sort((a, b) => (recency.get(b.id) ?? "").localeCompare(recency.get(a.id) ?? "") || a.name.localeCompare(b.name));
      /** The folders `host` does not trust and could from here, by project id (`INBOX_SCRATCH_PICK`: the scratch root). */
      const untrustedOf = (host: LaunchHost, pick: { agent: string; project: string } | null) => {
        const untrusted: Record<string, InboxLaunchUntrusted> = {};
        const look = (id: string, folder: string) => {
          if (host.trusts(folder)) return;
          const offer = host.trustOffer?.({ folder, scratch: false });
          if (!offer) return;
          if (pick?.agent !== host.agent || pick.project !== id) untrusted[id] = { folder: offer.folder };
          else {
            const { facts, warns } = offer.read();
            untrusted[id] = { folder: offer.folder, facts, warns };
          }
        };
        for (const project of projects) if (project.exists) look(project.id, project.root);
        look(INBOX_SCRATCH_PICK, root);
        return untrusted;
      };
      const offered = await Promise.all(
        hostList.map(async (host) => {
          const state = stateOf(host);
          // Not available last time: look again (the person may have just installed or updated it).
          const ok = await available(host, state.lastAvailable !== null && !state.lastAvailable.ok);
          state.lastAvailable = ok;
          // `scratch_trusted`: whether it starts in the scratch root without a trust prompt (the trust-once row).
          return ok.ok ? [{ agent: host.agent, name: host.name, scratch_trusted: host.trusts(root), ...(owner ? { untrusted: untrustedOf(host, owner.pick) } : {}) }] : [];
        }),
      );
      // Why the others can't start now, for a linked machine's window to say with this machine's name (remote launch).
      const notReady = hostList.flatMap((host) => {
        const last = stateOf(host).lastAvailable;
        if (!last || last.ok) return [];
        const code = last.code ?? "unknown";
        return [{ agent: host.agent, name: host.name, code, ...(code === "signed_out" && options.startedOverSsh ? { over_ssh: true as const } : {}) }];
      });
      return { agents: offered.flat(), projects, scratch: { root }, clone: { into: defaultCloneInto() }, ...(notReady.length > 0 ? { not_ready: notReady } : {}) };
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
      const runLine = runOfRoot(store.message(threadId)!);
      // Trust that would cover home, or `/`: the how-to says to start in a project with its own repository.
      // The home folder is never trusted: the how-to says to start in a folder inside it. Home in a repository rooted
      // there carries both: this window reads the first, and a window from before it, which knows only the second, keeps
      // that sentence rather than "run it here".
      const line = !runLine?.untrusted
        ? runLine
        : {
            ...runLine,
            ...(host.trustCoversHome?.(root.launch) ? { trust_covers_home: true as const } : {}),
            ...(samePlace(root.launch.folder, options.homeDir) ? { home_folder: true as const } : {}),
          };
      const offer = owner && line?.untrusted ? host.trustOffer?.(root.launch) : null;
      return offer ? { ...line!, trust: { warning: offer.read().warning } } : line;
    },

    /** The launch ended before its agent wrote: it failed, its CLI is gone, or it was stopped or went away (the thread's own line says which). */
    didNotStart(threadId: string): boolean {
      const root = store.message(threadId);
      if (!enabled() || !root?.launch || root.thread_id !== root.id) return false;
      const state = runOfRoot(root)?.state;
      return state === "failed" || state === "missing" || state === "stopped";
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

    /**
     * Whether a reply to this session starts it again: the session this thread's launch started, and an agent that is
     * neither gone nor without a host here. It has not ended, whatever its liveness says (the window's `launchResumes`).
     */
    resumes(threadId: string, session: string | null | undefined): boolean {
      const root = launchedRootOf(threadId, session);
      if (!root || !hostOf(root.launch!)) return false;
      const state = runOfRoot(root)?.state;
      return state !== "missing" && state !== "failed";
    },

    /** Whether the session this thread's launch started is gone (the line's "missing"), however recently it was heard from. */
    gone(threadId: string, session: string | null | undefined): boolean {
      const root = launchedRootOf(threadId, session);
      return !!root && runOfRoot(root)?.state === "missing";
    },

    /** A launched row with its run word, and a session blocked on a prompt placed in Stopped on you (through `rowDecorator`). */
    decorateLaunched<T extends InboxListRow>(row: T): T {
      const root = store.message(row.thread_id);
      if (!root?.launch) return row;
      const runLine = runOfRoot(root);
      if (runLine?.state === "waiting_terminal" && row.resolved_at === null) return { ...row, section: "stopped", unread: true, run: null };
      // A permission question waits on the person: the session is blocked on them (screen 09).
      if (runLine?.state === "waiting_answer" && row.resolved_at === null) return { ...row, section: "stopped", unread: true, run: null };
      const word = runLine?.state === "starting" || runLine?.state === "working" || runLine?.state === "cloning" ? runLine.state : null;
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
