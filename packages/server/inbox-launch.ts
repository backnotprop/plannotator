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
 *     the agent available (409 agent_unavailable). Nothing is written. A
 *     scratch launch (PR 3) then makes `<scratch root>/<thread-name slug>`
 *     (`-2`, `-3` when taken, never through a link); Delete purges and
 *     removes that folder, and only while it is still the one it made.
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
 * read at most every 10 s and only while a window watches and a line could
 * change (a turn runs, or the host last said it waits on a prompt). A
 * person's reply to a launched session that is not live respawns it
 * (`claude respawn`), once per reply; one that does not take reads failed.
 *
 * The person's login shell is read once when the Inbox starts, ahead each
 * time the composer picks "Start Claude Code" and for Settings → Agents when
 * stale (while the switch was never set: what it follows), and by each start
 * for its own env, after the Send answered. A Send decides from the last
 * finished read and waits only for one under way, or when none ever finished. Every other `claude`
 * call runs with the Inbox's own env through the launch filter
 * (`launchPlainEnv`), and none of them kills a process group.
 *
 * Window routes (same origin and `serverSession`; never over the tailnet for
 * Open and the settings):
 *   POST /api/inbox/launch/:id/stop      claude stop
 *   POST /api/inbox/launch/:id/open      Terminal: `claude attach` (or plain `claude` in an untrusted folder); macOS
 *   POST /api/inbox/launch/:id/delete    stop, rm, and the launch folder; the thread stays
 *   POST /api/inbox/launch/:id/retry     Try again after a failed start, respawn or connection
 *   POST /api/inbox/launch/settings      `{ full_permissions }` or `{ scratch_dir }` (Settings → Agents)
 *   GET  /api/inbox/launch/settings      the switch as it stands (never set: what the login shell says)
 *
 * And one route for the launched session's own permission hook, guarded like
 * the bridge (inbox-launch-permission.ts):
 *   POST /api/inbox/launch/:id/permission  the hook's long poll; the answer is the person's, from the thread
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { INBOX_HOST_NAMES, inboxId, type InboxComposeLaunch, type InboxLaunchAgent, type InboxLaunchRecord, type InboxListRow, type InboxMessage, type InboxProject, type InboxRun } from "@plannotator/core/inbox-types";
import { inboxRunOf, INBOX_RUN_START_GRACE_MS, type InboxRunHostState } from "@plannotator/core/inbox-run-line";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { inboxLaunchFullPermissions } from "@plannotator/core/inbox-permission";
import { derivePersonThreadSubject } from "@plannotator/core/inbox-questions";
import { inboxScratchCandidate, inboxScratchSlug } from "@plannotator/core/inbox-scratch";
import { loadConfig, resolveInboxLaunch, saveConfig } from "@plannotator/shared/config";
import { getDefaultPlannotatorDataDir, getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { INBOX_TOOL_NAME } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { agentVersionRun, claudeBypassSetup, claudeCodeInboxToolOn, claudeCodePluginEnabled, createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { claudeAttachCommand, claudeTrustCommand, CLAUDE_LAUNCH_MIN_VERSION, createClaudeHost, parseClaudeVersion, startFailureOf, versionAtLeast, type ClaudeAgent, type ClaudeHost, type ClaudeLaunchMode } from "./inbox-launch-claude";
import { launchPlainEnv, launchSettingsEnv, launchSpawnEnv, launchStartOf, shellSkipsPermissions, type LaunchEnv } from "./inbox-launch-env";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";
import { createLaunchPermissions } from "./inbox-launch-permission";

const HOST = "claude-code";
const AGENT_NAME = INBOX_HOST_NAMES[HOST] ?? "Claude Code";
/** The agent's own Inbox call never prompts, whatever the person's permission mode. */
const INBOX_TOOL_PERMISSION = `mcp__plannotator__${INBOX_TOOL_NAME}`;
const AVAILABLE_TTL_MS = 30_000;
/** Claude Code's hook timeout for the permission hook: four days, as the plugin's ExitPlanMode hook. */
const PERMISSION_HOOK_TIMEOUT_S = 345_600;

/** One shell word: single-quoted. */
const shellWord = (word: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The per-launch PermissionRequest hook: every tool (ExitPlanMode passes straight through to plan review). */
export function launchPermissionHooks(self: readonly string[]) {
  const command = [...self, "inbox", "permission-hook"].map(shellWord).join(" ");
  return { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command, timeout: PERMISSION_HOOK_TIMEOUT_S }] }] };
}
const HOST_TTL_MS = 10_000;

type Availability = { ok: true; version: string } | { ok: false; missing: boolean; reason: string };

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
}

export function createInboxLaunch(options: {
  store: InboxStore;
  live: { runStateOf(session: string): { busy: boolean | null; busySince: number | null; polls: number } | null };
  dataDir: string;
  serverSession: string;
  homeDir: string;
  platform: NodeJS.Platform;
  /** The person's login-shell env (inbox-launch-env.ts `createLoginEnv`): read for a launch, and for Settings → Agents while the switch was never set. */
  loginEnv: () => Promise<LaunchEnv>;
  /** The Inbox's own env (the plain calls: status, stop, respawn, rm). */
  ownEnv: () => Readonly<Record<string, string | undefined>>;
  /** Folders Claude Code installs itself in, searched after the Inbox's PATH (none in a sandboxed test). */
  installDirs: readonly string[];
  displayFolder: (path: string) => string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** The windows should read the list and open thread again (a start settled, a stop). */
  onChange: () => void;
  /** The argv that runs this Plannotator (the permission hook's command): the Inbox's own `selfCommand`. */
  selfCommand: readonly string[];
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
   * followed by the last login shell's and Claude's own install folders
   * (`installDirs`), so a `claude` the Inbox's PATH lacks is still found
   * without running a shell.
   */
  let loginPath: string[] = [];

  /**
   * The person's login shell: read once when the Inbox starts (`warm`), for Settings → Agents and the
   * composer's "Start Claude Code" while the switch was never set (what it follows), and by each start for
   * its own env, after the Send answered. One read at a time: callers meanwhile share it. Of a read only its
   * PATH (for the plain env), whether it exports Claude's skip-permissions switch, and its CLAUDE_CONFIG_DIR
   * are kept; the env itself is never held for a launch.
   */
  let shell: { skips: boolean; configDir: string | undefined; at: number } | null = null;
  /** Settings → Agents reads the shell again only when its last read is older than this. */
  const SHELL_READ_FRESH_MS = 60_000;
  const shellFresh = () => shell !== null && now() - shell.at < SHELL_READ_FRESH_MS;
  let reading: Promise<LaunchEnv> | null = null;
  const readLogin = (): Promise<LaunchEnv> => {
    reading ??= (async () => {
      try {
        const login = await options.loginEnv();
        if (login.PATH) loginPath = login.PATH.split(delimiter).filter(Boolean);
        shell = { skips: shellSkipsPermissions(login), configDir: login.CLAUDE_CONFIG_DIR, at: now() };
        return login;
      } finally {
        reading = null;
      }
    })();
    return reading;
  };
  /** Where the person's own Claude files are: their HOME and CLAUDE_CONFIG_DIR (the last shell read's, else the Inbox's). */
  const claudeFiles = () => {
    const configDir = shell?.configDir ?? options.ownEnv().CLAUDE_CONFIG_DIR;
    return createAgentEnvironmentFor({ platform: options.platform, homeDir: options.homeDir, env: configDir ? { CLAUDE_CONFIG_DIR: configDir } : {} });
  };
  /** The person's own Claude setup (bypass consent, a bypass disable, their default mode), read from their files now; `folder` adds that project's settings. */
  const claudeSetup = (folder: string | null = null) => claudeBypassSetup(claudeFiles(), folder);

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
   * Delete's last step for a scratch launch: `claude purge --yes <folder>` (that folder's sessions and transcripts)
   * and the folder itself, only while it is intact. Never for a project folder.
   */
  const removeScratch = async (launch: InboxLaunchRecord): Promise<boolean> => {
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
  /** The folder a start failure names and Open in Terminal trusts (the host's rule). */
  const trustFolderOf = (launch: InboxLaunchRecord) => host.trustFolder(launch);
  /** How a launch made now would start (`launchStartOf`), from the switch, the person's Claude setup and the last shell read. */
  const startNow = (setup: ReturnType<typeof claudeSetup>) =>
    launchStartOf({ setting: config().fullPermissions, defaultMode: setup.defaultMode, shellSkips: shell?.skips ?? false, consent: setup.consent, disabled: setup.disabled });
  /** A launch's `--permission-mode`: bypass for full permissions, none for the person's own default mode, else auto. */
  const modeOf = (launch: InboxLaunchRecord): ClaudeLaunchMode => (inboxLaunchFullPermissions(launch) ? "bypassPermissions" : launch.own_mode ? null : "auto");
  const environment = async (): Promise<AgentEnvironment> =>
    createAgentEnvironmentFor({
      platform: options.platform,
      homeDir: options.homeDir,
      env: launchPlainEnv(options.ownEnv(), [...loginPath, ...options.installDirs]),
    });
  const host: ClaudeHost = createClaudeHost({ environment, files: claudeFiles });

  // ── Availability: `claude` on the plain env's PATH (the Inbox's, the last start's login PATH, Claude's install folders), new enough, the plugin's mod and its Inbox tool on ──
  let availability: { at: number; value: Promise<Availability> } | null = null;
  const checkAvailable = async (): Promise<Availability> => {
    const e = await environment();
    const path = e.which("claude");
    if (!path) return { ok: false, missing: true, reason: "claude is not on the Inbox's PATH or in ~/.local/bin or ~/.claude/local" };
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
  /** Stale after 10 s, or once an answer settled since the last read (one read then says where the session is). */
  const hostStale = () => !hostView || now() - hostView.at > HOST_TTL_MS || permissions.readDue(hostView.at);
  const hostStateOf = (ref: string | null): InboxRunHostState | null => {
    if (!ref || !hostView?.agents) return null;
    const agent = hostView.agents.find((a) => a.id === ref || a.sessionId.startsWith(ref));
    return agent ? { status: agent.status, state: agent.state, waitingFor: agent.waitingFor } : "absent";
  };

  const memos = new Map<string, Memo>();
  const memoOf = (launch: InboxLaunchRecord): Memo => {
    let memo = memos.get(launch.id);
    if (!memo) {
      memo = { startedAt: Date.parse(launch.started_at), again: false, stoppedAt: null, waitingSince: null, quietPolls: null, respawn: null, busySeen: false };
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

  /** The reply's restart was refused because Claude Code does not trust the folder. */
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

  /** The run line of a launched root. */
  const runOfRoot = (root: InboxMessage): InboxRun | null => {
    const launch = root.launch!;
    if (launch.deleted_at) return null;
    const memo = memoOf(launch);
    const live = liveOf(root, memo);
    // A host read from before the last answer settled still shows our own prompt: never "waiting on Terminal".
    const settled = permissions.settledAfter(launch.id);
    const hostState = settled !== null && (hostView?.at ?? 0) < settled ? null : hostStateOf(launch.session_ref);
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
      turnWaiting: turnWaitingOf(root, memo),
      seenLive: !!root.delivery,
      host: hostState,
      waitingSince: memo.waitingSince,
      respawnFailed: respawnFailedOf(memo),
      respawnUntrusted: respawnUntrustedOf(memo),
      stoppedByPersonAt: memo.stoppedAt,
      attachCommand: launch.session_ref ? claudeAttachCommand(launch.folder, launch.session_ref) : null,
      permissionSince: permissions.openSince(root),
    });
  };

  /**
   * Whether the host's view could change this root's line: it last said it
   * waits on a prompt (until it says otherwise), a turn runs (a prompt may
   * block it), or it is not live past the start.
   */
  const needsHost = (root: InboxMessage): boolean => {
    const launch = root.launch!;
    if (launch.deleted_at || launch.error || !launch.session_ref) return false;
    // A permission question waits: the host says whether the person answered it in Terminal meanwhile.
    if (permissions.holds(launch.id)) return true;
    // An answer not yet read past: the host says whether the session went on or waits on its own dialog.
    const settled = permissions.settledAfter(launch.id);
    if (settled !== null && (hostView?.at ?? 0) < settled) return true;
    const cached = hostStateOf(launch.session_ref);
    if (cached && cached !== "absent" && cached.status === "waiting") return true;
    const memo = memoOf(launch);
    const live = liveOf(root, memo);
    if (live) return live.busy === true;
    if (now() - memo.startedAt < INBOX_RUN_START_GRACE_MS) return false;
    const state = hostStateOf(launch.session_ref);
    return !(state === "absent" || (state && (state.state === "stopped" || state.state === "done")));
  };

  const roots = () => store.launchedRoots();
  const permissions = createLaunchPermissions({
    store,
    launchDir,
    rootOf: (launchId) => roots().find((root) => root.launch!.id === launchId && !root.launch!.deleted_at) ?? null,
    roots: () => roots().filter((root) => !root.launch!.deleted_at),
    displayFolder: options.displayFolder,
    host: { stateOf: (ref) => hostStateOf(ref), readAt: () => hostView?.at ?? 0 },
    onChange: options.onChange,
    now,
    log,
  });
  const rootById = (launchId: string): InboxMessage => {
    const root = roots().find((m) => m.launch!.id === launchId);
    if (!root) throw new InboxError("launch_not_found", `No launch ${launchId}.`);
    return root;
  };

  /**
   * Look at every launch: respawn a stopped session someone wrote to, and,
   * only while a window watches (`watched`), keep the CLI check and the
   * host's view fresh where a line could change.
   */
  const sweep = (watched: boolean) => {
    if (!enabled()) {
      // Launch turned off: a question no one can answer any more is withdrawn (nothing to do once none is open).
      for (const root of roots()) if (!root.launch!.deleted_at) permissions.withdrawAll(root);
      return;
    }
    const all = roots().filter((root) => !root.launch!.deleted_at);
    if (all.length === 0) return;
    for (const root of all) maybeRespawn(root);
    permissions.sweep();
    if (!watched) return;
    if (lastAvailable === null || (availability && now() - availability.at > AVAILABLE_TTL_MS)) refreshAvailable();
    if (hostStale() && all.some(needsHost)) void refreshHost();
  };

  // ── Start ──

  /**
   * The launch's settings file. Every launch, full included, has the permission hook: whatever Claude still
   * asks (bypass mode's safety checks; every prompt when Claude declined bypass) comes to a card, never to a
   * Terminal dialog no one sees. An auto launch pins `defaultMode: "default"`: when Claude drops auto mode
   * (its killswitch, a CLI without it) the session lands in default mode, never in the person's own bypass.
   */
  const writeSettings = (launch: InboxLaunchRecord, login: LaunchEnv, model: string | null): string => {
    const fullPermissions = inboxLaunchFullPermissions(launch);
    const dir = launchDir(launch.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "settings.json");
    const isDefaultDataDir = resolve(options.dataDir) === resolve(getDefaultPlannotatorDataDir(options.homeDir));
    const settings = {
      ...(model ? { model } : {}),
      env: launchSettingsEnv(login, {
        launchId: launch.id,
        key: randomBytes(32).toString("hex"),
        dataDir: isDefaultDataDir ? null : options.dataDir,
        fullPermissions,
        bypassAvailable: launch.bypass_available === true,
      }),
      permissions: { allow: [INBOX_TOOL_PERMISSION], ...(modeOf(launch) === "auto" ? { defaultMode: "default" } : {}) },
      // Permission prompts come to the launch thread as questions (inbox-launch-permission.ts).
      hooks: launchPermissionHooks(options.selfCommand),
    };
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };

  /** Launches whose `claude --bg` is running now: Try again waits, and Delete leaves the new session to `run` to remove. */
  const starting = new Set<string>();
  /** A Delete under way, by launch id: a second one (a double click) waits for it and answers the same. */
  const deleting = new Map<string, Promise<Record<string, unknown>>>();

  /** Start (or start again after a failed start) the agent for a launched root, in the background. */
  const run = async (root: InboxMessage, again: boolean): Promise<void> => {
    const launch = root.launch!;
    const memo = memoOf(launch);
    memo.startedAt = now();
    memo.again = again;
    memo.stoppedAt = null;
    memo.respawn = null;
    memo.busySeen = false;
    starting.add(launch.id);
    try {
      // The person's login env, read for this start only (after the Send answered; never kept).
      const login = await readLogin();
      // How it starts comes from the launch record (fixed when it was made), never the live switch or shell:
      // a Try again after either changed starts the session the card describes.
      const { model } = config();
      const settingsPath = writeSettings(launch, login, model);
      const name = root.thread_name ?? root.subject ?? "Inbox";
      const startEnvironment = createAgentEnvironmentFor({ platform: options.platform, homeDir: options.homeDir, env: launchSpawnEnv(login) });
      // Full permissions: bypass mode. The person's own default mode: no flag. Otherwise auto mode; its prompts come to the thread.
      const mode = modeOf(launch);
      const result = await host.start({
        folder: launch.folder,
        shownFolder: options.displayFolder(trustFolderOf(launch)),
        name,
        settingsPath,
        mode,
        allowBypass: launch.bypass_available === true,
        environment: startEnvironment,
      });
      startLog(launch.id, result.output);
      if (result.modeRefused) {
        startLog(launch.id, `auto mode refused, started in default mode: ${result.modeRefused}`);
        log(`Inbox launch ${launch.id}: auto mode refused (${result.modeRefused}); started in default mode`);
      }
      // Deleted while it started: the session it made goes too, and the thread stays as the person left it.
      if (store.message(root.id)?.launch?.deleted_at) {
        if (result.ok) {
          const stop = await host.stop(result.short);
          const rm = await host.rm(result.short);
          log(`Inbox launch ${launch.id}: deleted while starting; removed ${result.short} (stop ${stop.exitCode}, rm ${rm.exitCode})`);
        }
        await removeScratch(launch);
        rmSync(launchDir(launch.id), { recursive: true, force: true });
        return;
      }
      if (result.ok) store.settleLaunch(root.id, { to: { host: HOST, session: result.session }, session_ref: result.short });
      else store.settleLaunch(root.id, { error: { code: result.missing ? "missing" : result.code, text: result.text, at: new Date(now()).toISOString() } });
      log(`Inbox launch ${launch.id}: ${result.ok ? `started ${result.short}` : `did not start (${result.code})`}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      startLog(launch.id, `error: ${text}`);
      if (!store.message(root.id)?.launch?.deleted_at) store.settleLaunch(root.id, { error: { code: "failed", text, at: new Date(now()).toISOString() } });
    } finally {
      starting.delete(launch.id);
      hostView = null;
      options.onChange();
    }
  };

  // ── Respawn on reply: a person's message for a launched session that is not live ──
  const respawning = new Set<string>();
  /** `claude respawn` once; a non-zero exit is kept as the failure (and the CLI looked at again, for screen 15). */
  const respawn = (root: InboxMessage, forReply: string) => {
    const launch = root.launch!;
    const memo = memoOf(launch);
    respawning.add(launch.id);
    memo.startedAt = now();
    memo.again = true;
    memo.stoppedAt = null;
    memo.quietPolls = options.live.runStateOf(root.to!.session)?.polls ?? memo.quietPolls;
    memo.respawn = { for: forReply, connected: false, failed: null };
    memo.busySeen = false;
    const attempt = memo.respawn;
    options.onChange();
    void host
      .respawn(launch.session_ref!)
      .then(async (result) => {
        startLog(launch.id, `respawn ${launch.session_ref}: exit ${result.exitCode}\n${result.stdout}${result.stderr}`);
        if (result.exitCode === 0) return;
        const failure = startFailureOf(result, options.displayFolder(trustFolderOf(launch)));
        attempt.failed = failure.text;
        // Claude checks trust before a restart too (a scratch folder that became its own repository needs its own).
        attempt.untrusted = failure.code === "untrusted";
        lastAvailable = await available(true);
      })
      .finally(() => {
        options.onChange();
        respawning.delete(launch.id);
        hostView = null;
      });
  };
  const maybeRespawn = (root: InboxMessage) => {
    const launch = root.launch!;
    // Only a session that connected once: one that never did is "not connected", and respawning it would not help.
    if (launch.deleted_at || launch.error || !launch.session_ref || !root.to || !root.delivery || respawning.has(launch.id) || starting.has(launch.id)) return;
    const memo = memoOf(launch);
    if (liveOf(root, memo)) return;
    if (now() - memo.startedAt < INBOX_RUN_START_GRACE_MS) return;
    const newest = store.pendingReplies(root.to.session, { tags: true }).at(-1);
    // Once per reply: one that did not take waits for Try again or the person's next reply.
    if (!newest || memo.respawn?.for === newest.id) return;
    respawn(root, newest.id);
  };
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message" || !enabled()) return;
    const message = line.record;
    if (message.author.kind !== "person" || message.id === message.thread_id || message.delivery) return;
    const root = store.message(message.thread_id);
    if (root?.launch) queueMicrotask(() => maybeRespawn(store.message(root.id) ?? root));
  });

  // ── Routes ──

  /**
   * Settings → Agents' switch: the person's choice once set; never set, what their own setup says
   * (`follows`: on because their Claude settings or their shell run Claude in bypass mode). `own_mode`: a
   * launch starts in their own default mode; `bypass_off`: they want full permissions, and Claude Code's
   * settings turn bypass mode off (`disableBypassPermissionsMode`); `needs_consent`: they want them, and Claude Code's
   * bypass notice is not accepted on this computer, so a launch starts without them. `settingsState` uses
   * the last shell read; the window's GET reads the shell again when that read is older than a minute.
   */
  const settingsState = () => {
    const setting = config().fullPermissions;
    const setup = claudeSetup();
    const start = startNow(setup);
    const follows = setting === null && start.wantsFull ? (setup.defaultMode === "bypassPermissions" ? "claude" : "shell") : null;
    return {
      enabled: enabled(),
      full_permissions: setting ?? start.wantsFull,
      follows,
      own_mode: start.ownMode,
      bypass_off: start.wantsFull && setup.disabled,
      needs_consent: start.wantsFull && !setup.disabled && !setup.consent,
      // Settings → Agents' "Scratch folders": where new ones go.
      scratch_dir: scratchRoot(),
      scratch_dir_shown: options.displayFolder(scratchRoot()),
    };
  };
  const route = async (req: Request, path: string, via: "local" | "tailnet" | string): Promise<Response | null> => {
    const match = /^\/api\/inbox\/launch\/(settings|lch_[0-9A-HJKMNP-TV-Z]{26})(?:\/(stop|open|delete|retry))?$/.exec(path);
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
        // Nothing waits on a stopped session's prompt: its questions are withdrawn at once.
        permissions.withdrawAll(root);
        // Its last polls still read as live for a while: from now it counts as live only once it polls anew.
        if (root.to) memo.quietPolls = options.live.runStateOf(root.to.session)?.polls ?? memo.quietPolls;
        hostView = null;
        options.onChange();
        return json({ run: runOfRoot(store.message(root.id)!) });
      }
      case "open": {
        if (via === "tailnet") return localOnly();
        const e = await environment();
        // osascript is what decides, not the platform, so the e2e specs' fake runs on a Linux CI runner too.
        const osascript = e.which("osascript");
        if (!osascript) throw new InboxError("open_unavailable", options.platform === "darwin" ? "osascript is not on PATH; copy the command instead." : "Open in Terminal is for macOS; copy the command instead.");
        // A start or restart Claude refused for trust: plain `claude` where trust is keyed, so its trust prompt shows.
        const untrusted = !!launch.error || respawnUntrustedOf(memoOf(launch));
        const command = launch.session_ref && !untrusted ? claudeAttachCommand(launch.folder, launch.session_ref) : claudeTrustCommand(trustFolderOf(launch));
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
            const rm = await host.rm(launch.session_ref);
            log(`Inbox launch ${launch.id}: deleted (stop ${stop.exitCode}, rm ${rm.exitCode})`);
          }
          permissions.withdrawAll(root);
          permissions.forget(launch.id);
          // A project folder: never `claude purge` (it clears every session of the folder, and this is the person's
          // project). A scratch folder the Inbox made: purged and removed, by `run` when it still starts.
          const scratchRemoved = starting.has(launch.id) ? null : await removeScratch(launch);
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
        if (starting.has(launch.id) || respawning.has(launch.id)) throw new InboxError("validation_error", "It is starting already.");
        if (!isFolder(launch.folder)) throw new InboxError("folder_missing", `${options.displayFolder(launch.folder)} isn't there any more.`);
        const memo = memoOf(launch);
        // A reply's respawn that did not take: respawn once more (the session exists; a new --bg would make a second).
        if (!launch.error && launch.session_ref && root.to && respawnFailedOf(memo)) {
          respawn(root, memo.respawn!.for);
          return json({ run: runOfRoot(store.message(root.id)!) });
        }
        if (!launch.error) {
          // Started but never connected (or cut off by an Inbox restart): respawn the session it made, or start anew without one.
          if (runOfRoot(root)?.state !== "failed") throw new InboxError("validation_error", "That launch did not fail.");
          if (launch.session_ref && root.to && !root.to.session.startsWith("launch:")) respawn(root, memo.respawn?.for ?? root.id);
          // No session was made: a first start, not "again".
          else void run(root, false);
          return json({ run: runOfRoot(store.message(root.id)!) });
        }
        const cleared = store.settleLaunch(root.id, { error: null });
        // The start never ran (untrusted, failed): Try again is its first real start, never "Starting … again".
        void run(cleared, false);
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
    /** Once at Inbox start, with launch on: the login shell read ahead, so a Send rarely waits on it. */
    warm(): void {
      if (enabled()) void readLogin().catch(() => {});
    },
    route,
    sweep,
    stop: () => unsubscribe(),

    /**
     * The launched session's permission hook (`POST /api/inbox/launch/:id/permission`), after the
     * caller's connection guard: null for any other path. Off, 404 `launch_off` (the hook then says nothing).
     */
    async permissionRoute(req: Request, path: string): Promise<Response | null> {
      const match = /^\/api\/inbox\/launch\/(lch_[0-9A-HJKMNP-TV-Z]{26})\/permission$/.exec(path);
      if (!match) return null;
      if (!enabled()) return json({ error: "Launch is off.", code: "launch_off" }, 404);
      return permissions.handle(req, match[1]!);
    },

    /** Compose's `to.launch`, when launch is on: `{ agent, project_id }` or `{ agent, scratch: true }`; null for any other `to`. */
    target(to: unknown): InboxLaunchTarget | null {
      if (!to || typeof to !== "object" || !("launch" in to)) return null;
      if (!enabled()) throw new InboxError("launch_off", "Starting agents from the Inbox is off.");
      const value = (to as { launch: unknown }).launch as Record<string, unknown> | null;
      if (value && typeof value === "object" && value.agent === HOST && value.scratch === true && value.project_id === undefined) return { agent: HOST, scratch: true };
      if (!value || typeof value !== "object" || value.agent !== HOST || typeof value.project_id !== "string") {
        throw new InboxError("validation_error", "to.launch: { agent: \"claude-code\", project_id } or { agent: \"claude-code\", scratch: true }.", { field: "to.launch" });
      }
      return { agent: HOST, project_id: value.project_id };
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
      const chosen = "project_id" in target ? store.project(target.project_id) : null;
      if ("project_id" in target && !chosen) throw new InboxError("project_not_found", `No project ${target.project_id}.`);
      if (chosen && !isFolder(chosen.root)) {
        throw new InboxError("folder_missing", `${options.displayFolder(chosen.root)} isn't there any more. Pick another project. Nothing was sent.`, { field: "to.launch" });
      }
      const ok = await available(true);
      lastAvailable = ok;
      if (!ok.ok) throw new InboxError("agent_unavailable", `${AGENT_NAME} can't be started here: ${ok.reason}. Nothing was sent.`);
      const id = inboxId("lch");
      // How it starts, fixed for this launch (`launchStartOf`): the switch, the person's own Claude setup (with
      // this folder's settings) and the last finished shell read, however old (the start reads the shell again
      // for its own env). Send waits on the shell only to finish a read already under way (the composer's read
      // ahead, or another launch's start), or when no read ever finished (`warm` reads one at Inbox start).
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
      const start = startNow(claudeSetup(folder));
      const launch: InboxLaunchRecord = {
        id,
        agent: HOST,
        session_ref: null,
        folder,
        scratch: !chosen,
        ...(made ? { scratch_inode: made.inode } : {}),
        started_at: new Date(now()).toISOString(),
        ...(start.full ? { full_permissions: true } : {}),
        ...(start.ownMode ? { own_mode: true } : {}),
        ...(start.bypass ? { bypass_available: true } : {}),
      };
      return { project, to: { host: HOST, session: `launch:${id}` }, launch };
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
      // A scratch folder Delete removed is not offered again (it would only be listed struck through).
      const removed = new Set(roots().filter((root) => root.launch!.scratch && root.launch!.deleted_at).map((root) => root.launch!.folder));
      const projects = store
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, root: p.root, exists: isFolder(p.root) }))
        .filter((p) => p.exists || !removed.has(p.root))
        .sort((a, b) => (recency.get(b.id) ?? "").localeCompare(recency.get(a.id) ?? "") || a.name.localeCompare(b.name));
      const root = scratchRoot();
      return { agents: ok.ok ? [{ agent: HOST, name: AGENT_NAME, scratch_trusted: host.trusts(root) }] : [], projects, scratch: { root } };
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

    /** A launched thread's attach command (the ⋯ menu's Copy, also while the agent rests and has no line), or null. */
    attachOf(threadId: string): string | null {
      const launch = store.message(threadId)?.launch;
      return launch?.session_ref && !launch.deleted_at && !launch.error ? claudeAttachCommand(launch.folder, launch.session_ref) : null;
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
