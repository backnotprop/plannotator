/**
 * The Claude Code host for launch (PLAN "Claude: start, env, permissions"):
 * `createClaudeLaunchHost`, the `LaunchHost` (inbox-launch-host.ts) the
 * engine holds as `claude-code`, built on `createClaudeHost`, the CLI calls.
 * Its permission hook, key and leases are inbox-launch-claude-permission.ts.
 *
 * Claude's own supervisor keeps the session alive (`claude --bg`); this file
 * only asks it to start, stop, respawn and remove one, and reads its state
 * with `claude agents --json --all`. The session connects through the mod's
 * bridge poll, which says whether it is live and busy. Contract recorded in
 * `.ops/work/bg-test/RESULTS.md` and `bg-perm-test/RESULTS.md`:
 *
 * - `--bg` takes no prompt here (the first turn is the Inbox's own wake) and
 *   ignores `--session-id`, so the short id comes from its stdout
 *   (`backgrounded · <8 hex> · <name> …`) and the full id from
 *   `agents --json --all --cwd <folder>`, matched as a prefix.
 * - Everything we pass lives in the per-launch settings FILE, never as a
 *   variadic flag (they swallow arguments) and never inline (values in `ps`).
 * - `stop` leaves `done` and drops the session from the list without `--all`.
 *
 * Every run goes through `AgentEnvironment` (packages/server/inbox-agents.ts):
 * its own process group, no stdin, a time limit. On the limit only the CLI
 * itself is killed, never its group: any of these calls may be the one that
 * starts the person's shared supervisor (`claude daemon run`), and killing
 * that would end every background session they have. Tests put a fake
 * `claude` first on PATH (tests/helpers/fake-claude/).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inboxLaunchFullPermissions } from "@plannotator/core/inbox-permission";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { INBOX_TOOL_NAME } from "@plannotator/shared/inbox/connection";
import { readAgentFile } from "./agent-files";
import {
  agentVersionRun,
  claudeBypassSetup,
  claudeCodeInboxToolOn,
  claudeCodePluginEnabled,
  CLAUDE_JSON_MAX_BYTES,
  claudeGlobalConfigPath,
  createAgentEnvironmentFor,
  type AgentEnvironment,
  type AgentRunResult,
} from "./inbox-agents";
import { CLAUDE_NAME, createLaunchPermissions, launchPermissionHooks } from "./inbox-launch-claude-permission";
import { CLAUDE_SKIP_PERMISSIONS_ENV, launchSettingsEnv, launchSpawnEnv, launchStartOf, shellSkipsPermissions, type LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchHost, LaunchHostContext, LaunchHostResult } from "./inbox-launch-host";

/** The first Claude Code with `--bg`, `agents --json`, `respawn` as tested. Below it the To row is not offered. */
export const CLAUDE_LAUNCH_MIN_VERSION = "2.1.314";

const START_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 15_000;

/** The short id and name `claude --bg` printed, or null. */
export function parseBackgrounded(stdout: string): { short: string; name: string } | null {
  const match = /backgrounded · ([0-9a-f]{8}) · ([^\n]*?)(?: \(idle[^\n]*\))?\s*$/m.exec(stdout);
  return match ? { short: match[1]!, name: match[2]!.trim() } : null;
}

/** `2.1.314 (Claude Code)` → `2.1.314`. */
export function parseClaudeVersion(stdout: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.[0] ?? null;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** One entry of `claude agents --json`, the fields we read. */
export interface ClaudeAgent {
  id: string;
  sessionId: string;
  status: string | null;
  state: string | null;
  waitingFor: string | null;
}

export function parseAgentsJson(stdout: string): ClaudeAgent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const sessionId = text(e.sessionId);
    if (!sessionId) return [];
    return [{ id: text(e.id) ?? sessionId.slice(0, 8), sessionId, status: text(e.status), state: text(e.state), waitingFor: text(e.waitingFor) }];
  });
}

/** The entry whose short id is `short`: its `id`, else the one `sessionId` it prefixes. Null when none or ambiguous. */
export function agentByShort(agents: readonly ClaudeAgent[], short: string): ClaudeAgent | null {
  const exact = agents.filter((agent) => agent.id === short);
  if (exact.length === 1) return exact[0]!;
  const prefixed = agents.filter((agent) => agent.sessionId.startsWith(short));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

export type ClaudeStartFailure = { code: "untrusted" | "failed"; text: string };

/** The permission mode a launch starts in: bypass (full permissions), auto, or null (the person's own `defaultMode`, no flag). */
export type ClaudeLaunchMode = "bypassPermissions" | "auto" | null;

/**
 * A start a CLI refused for `--permission-mode auto`: Claude's own refusal of the flag's value
 * (`error: option '--permission-mode <mode>' argument 'auto' is invalid.`), a CLI without auto mode.
 * Such a start is made again with no `--permission-mode`, in default mode.
 */
export function refusedForMode(result: Pick<AgentRunResult, "exitCode" | "timedOut" | "stdout" | "stderr">): boolean {
  if (result.exitCode === 0 || result.timedOut) return false;
  return /option '--permission-mode <mode>' argument 'auto' is invalid/.test(`${result.stderr}\n${result.stdout}`);
}

/** Why `claude --bg` did not start a session, in words for the run line (screen 14). */
export function startFailureOf(result: Pick<AgentRunResult, "exitCode" | "timedOut" | "stdout" | "stderr">, folder: string): ClaudeStartFailure {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/workspace not trusted|not a trusted/i.test(output)) {
    return { code: "untrusted", text: `${folder} isn't a trusted folder yet. Open it once in Terminal and accept Claude Code's trust prompt, then try again.` };
  }
  if (result.timedOut) return { code: "failed", text: "Claude Code took too long to start." };
  const line = output.split("\n").map((l) => l.trim()).find((l) => l && !/^Starting background service/.test(l));
  return { code: "failed", text: line ? line.slice(0, 300) : `claude exited with code ${result.exitCode}.` };
}

/** POSIX single-quoted. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that opens the session in a terminal (the ⋯ menu's Copy attach command). */
export function claudeAttachCommand(folder: string, short: string): string {
  return `cd ${shellQuote(folder)} && claude attach ${short}`;
}

// ── Workspace trust, as Claude Code keys it (code.claude.com/docs permissions, "workspace trust"; the launch's
// real-CLI runs on 2.1.314: a plain child folder started under a trusted plain parent, and a child that was its
// own repository was refused under one). `--bg` and a restart both check it; only an interactive `claude`
// accepts it, or an edit of `~/.claude.json`, which the Inbox never makes. ──

type TrustTable = Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
/** The last `projects` table read, per config path, kept while the file (inode, mtime, size) stays: compose asks every 5 s. */
const trustTables = new Map<string, { key: string; table: TrustTable | null }>();
function trustTableOf(path: string): TrustTable | null {
  let key: string;
  try {
    const stat = statSync(path);
    key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    trustTables.delete(path);
    return null;
  }
  const cached = trustTables.get(path);
  if (cached && cached.key === key) return cached.table;
  let table: TrustTable | null = null;
  const global = readAgentFile(path, CLAUDE_JSON_MAX_BYTES);
  if (global.kind === "file") {
    try {
      const projects = (JSON.parse(global.text) as { projects?: unknown }).projects;
      if (projects && typeof projects === "object") table = projects as TrustTable;
    } catch {
      // Unreadable: not trusted.
    }
  }
  trustTables.set(path, { key, table });
  return table;
}

/**
 * Whether Claude Code trusts `folder`: in a git repository, through the repository root's own entry only (a
 * parent's trust never covers a nested repository); outside one, the folder's or any folder's above it.
 * Read from `projects[<path>].hasTrustDialogAccepted` in its global config. Read only. Unreadable: not trusted.
 */
export function claudeTrustsFolder(e: AgentEnvironment, folder: string): boolean {
  const table = trustTableOf(claudeGlobalConfigPath(e));
  if (!table) return false;
  for (let dir = folder; ; dir = dirname(dir)) {
    if (table[dir]?.hasTrustDialogAccepted === true) return true;
    // A repository's root: only its own entry counts.
    if (existsSync(join(dir, ".git"))) return false;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Where a launch's trust is accepted (its untrusted failure names it; Open in Terminal runs `claude` there). A
 * scratch folder: the scratch root, so one trust covers every plain folder in it; but one the agent made a
 * repository (`git init`) is keyed on its own root, which the root's trust does not cover.
 */
export function claudeTrustFolder(folder: string, scratch: boolean): string {
  return scratch && !existsSync(join(folder, ".git")) ? dirname(folder) : folder;
}

/**
 * The repository a folder sits in below its root (a `.git` in a folder above it), or null. `claude purge <folder>`
 * there also drops that repository's own `~/.claude.json` entry (its trust, history and MCP servers; the purge
 * smoke on 2.1.314), so a scratch folder inside one is never purged.
 */
export function claudeRepositoryAbove(folder: string): string | null {
  for (let dir = dirname(folder); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Claude's transcripts folder name for a project path: every character but a letter or digit as `-`. */
function claudeProjectDirName(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Why `claude purge <folder>` may reach past that folder, or null when it may run. `plan` is the stdout of
 * `claude purge --dry-run <folder>` (null: before the dry run, the folder's own checks only).
 *
 * As run on 2.1.314 (the purge smoke), purge deletes the `projects[...]` entries of the folder and of the git
 * repository Claude maps it to. A folder below a repository's root maps to that root, and a linked worktree
 * (a `.git` FILE: `gitdir: <repo>/.git/worktrees/<name>`) maps to its main repository, so either would drop the
 * person's own project entry (its trust, allowed tools, MCP servers, history). A folder that is its own repository
 * (a `.git` folder) maps to itself. So: no `.git` above, none in the folder but a real folder, and the plan must
 * name only this folder's entry and its own transcripts folder; anything else, or a plan that can't be read, is
 * refused.
 */
export function claudePurgeRefusal(folder: string, plan: string | null): string | null {
  const repository = claudeRepositoryAbove(folder);
  if (repository) return `inside the repository ${repository}, whose own entry purge would remove`;
  try {
    if (!lstatSync(join(folder, ".git")).isDirectory()) return "its .git is not a folder (a linked worktree maps to its main repository)";
  } catch {
    // No .git: a plain folder.
  }
  if (plan === null) return null;
  const configs: string[] = [];
  const dirs: string[] = [];
  for (const line of plan.split("\n")) {
    const config = /^\s*config:\s+projects\["(.*)"\]\s*$/.exec(line);
    if (config) configs.push(config[1]!);
    const dir = /^\s*dir:\s+(\S.*?)\s*$/.exec(line);
    if (dir) dirs.push(dir[1]!);
  }
  if (configs.length === 0 && dirs.length === 0) return "its dry run listed nothing it can read";
  const other = configs.find((key) => key !== folder);
  if (other !== undefined) return `its dry run also lists projects["${other}"]`;
  const otherDir = dirs.find((dir) => /\/projects\/[^/]+\/?$/.test(dir) && basename(dir) !== claudeProjectDirName(folder));
  if (otherDir !== undefined) return `its dry run also lists ${otherDir}`;
  return null;
}

/** What Open in Terminal runs when no session exists yet (an untrusted folder): plain `claude`, so its trust prompt shows. */
export function claudeTrustCommand(folder: string): string {
  return `cd ${shellQuote(folder)} && claude`;
}

/**
 * `environment`: the plain env every call but the start runs with (status,
 * stop, respawn, rm). The start brings its own: the person's login shell,
 * read for that launch only.
 */
export function createClaudeHost(options: {
  environment: () => Promise<AgentEnvironment>;
  /** Where the person's own Claude files are (their HOME and CLAUDE_CONFIG_DIR): the trust read. */
  files: () => AgentEnvironment;
}) {
  const run = async (argv: string[], cwd: string | undefined, timeoutMs = COMMAND_TIMEOUT_MS, environment?: AgentEnvironment) => {
    const e = environment ?? (await options.environment());
    const claude = e.which("claude");
    if (!claude) return { result: { exitCode: 127, timedOut: false, stdout: "", stderr: "claude is not on PATH" } as AgentRunResult, missing: true };
    return { result: await e.run([claude, ...argv], { timeoutMs, killGroup: false, ...(cwd ? { cwd } : {}) }), missing: false };
  };

  /** Every session Claude's supervisor knows (`--all`), or null when it could not be read. */
  const agents = async (cwd?: string): Promise<ClaudeAgent[] | null> => {
    const { result } = await run(["agents", "--json", "--all", ...(cwd ? ["--cwd", cwd] : [])], cwd);
    return result.exitCode === 0 ? parseAgentsJson(result.stdout) : null;
  };

  return {
    agents,
    /**
     * `claude --bg` in `folder` with the launch's settings file, then the full
     * session id. `allowBypass` (the person recorded bypass consent) adds
     * `--allow-dangerously-skip-permissions`, so the session may switch to
     * bypass later (the card's Full permissions); `mode` adds `--permission-mode`
     * (null: the person's own default mode). Nothing else goes on argv. Auto
     * mode refused (a CLI without it): started again with no mode (an auto
     * launch's settings file pins default mode), and `modeRefused` says why.
     * A failure names the folder as `shownFolder` (`~/…`).
     */
    async start(input: {
      folder: string;
      shownFolder: string;
      name: string;
      settingsPath: string;
      mode: ClaudeLaunchMode;
      allowBypass: boolean;
      environment: AgentEnvironment;
    }): Promise<({ ok: true; session: string; short: string } | ({ ok: false; missing: boolean } & ClaudeStartFailure)) & { output: string; modeRefused?: string }> {
      // A name that starts with "-" would read as a flag.
      const name = input.name.replace(/^-+/, "").trim() || "Inbox";
      const base = ["--bg", "--name", name, "--settings", input.settingsPath, ...(input.allowBypass ? ["--allow-dangerously-skip-permissions"] : [])];
      let { result, missing } = await run([...base, ...(input.mode ? ["--permission-mode", input.mode] : [])], input.folder, START_TIMEOUT_MS, input.environment);
      let output = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
      let modeRefused: string | undefined;
      if (input.mode === "auto" && !missing && refusedForMode(result)) {
        modeRefused = startFailureOf(result, input.shownFolder).text;
        ({ result, missing } = await run(base, input.folder, START_TIMEOUT_MS, input.environment));
        output = `${output}\n[auto mode refused; started again with no --permission-mode]\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
      }
      const more = modeRefused ? { modeRefused } : {};
      const started = result.exitCode === 0 ? parseBackgrounded(result.stdout) : null;
      if (!started) return { ok: false, missing, ...startFailureOf(result, input.shownFolder), output, ...more };
      // The supervisor lists the session as soon as `--bg` returns; a short retry covers a busy one.
      for (let attempt = 0; attempt < 5; attempt++) {
        const found = agentByShort((await agents(input.folder)) ?? [], started.short);
        if (found) return { ok: true, session: found.sessionId, short: started.short, output, ...more };
        await Bun.sleep(400);
      }
      // Never leave it running unseen (Try again would start a second one): stop and remove it first.
      const stop = (await run(["stop", started.short], undefined)).result;
      const rm = (await run(["rm", started.short], undefined)).result;
      return {
        ok: false,
        missing: false,
        code: "failed",
        text: `Claude Code started ${started.short} but did not list it.`,
        output: `${output}\n[not listed: stop ${started.short} exit ${stop.exitCode}, rm exit ${rm.exitCode}]`,
      };
    },
    stop: async (short: string) => (await run(["stop", short], undefined)).result,
    respawn: async (short: string) => (await run(["respawn", short], undefined)).result,
    rm: async (short: string) => (await run(["rm", short], undefined)).result,
    /**
     * `claude purge --yes <folder>`: every session, transcript and `~/.claude.json` entry Claude keeps for that folder
     * (`--yes`: no confirmation, which would wait on a terminal no one sees). Only ever a scratch folder, and only
     * when it reaches nothing else (`claudePurgeRefusal`): `--dry-run` first, and the plan must name that folder alone.
     */
    purge: async (folder: string): Promise<AgentRunResult & { skipped?: string }> => {
      const skip = (why: string, result?: AgentRunResult) => ({ ...(result ?? { exitCode: 0, timedOut: false, stdout: "", stderr: "" }), skipped: why });
      const before = claudePurgeRefusal(folder, null);
      if (before) return skip(before);
      const dry = (await run(["purge", "--dry-run", folder], undefined)).result;
      // Exit 1 with nothing found ("No Claude Code project state found"): nothing to purge.
      if (dry.exitCode !== 0) return skip(`the dry run exited ${dry.exitCode}`, dry);
      const planned = claudePurgeRefusal(folder, dry.stdout);
      if (planned) return skip(planned, dry);
      return (await run(["purge", "--yes", folder], undefined)).result;
    },
    /** Whether Claude Code trusts `folder` already (its real path or its path as given; read only). */
    trusts(folder: string): boolean {
      const files = options.files();
      let real = resolve(folder);
      try {
        real = realpathSync(folder);
      } catch {
        // Not made yet: its path as given.
      }
      return claudeTrustsFolder(files, real) || claudeTrustsFolder(files, resolve(folder));
    },
    /** Where a launch's trust is accepted: its untrusted failure names it, and Open in Terminal runs `claude` there. */
    trustFolder: (launch: { folder: string; scratch: boolean }) => claudeTrustFolder(launch.folder, launch.scratch),
  };
}

export type ClaudeHost = ReturnType<typeof createClaudeHost>;

// ── The launch host ──

const CLAUDE = "claude-code" as const;
/** The agent's own Inbox call never prompts, whatever the person's permission mode. */
const INBOX_TOOL_PERMISSION = `mcp__plannotator__${INBOX_TOOL_NAME}`;

const resultOf = (result: AgentRunResult): LaunchHostResult => ({ exitCode: result.exitCode, text: `${result.stdout}${result.stderr}` });

/**
 * Claude Code as a `LaunchHost`. Beyond the interface it keeps `settingsState`, Settings → Agents' Claude
 * words (the full-permissions switch), until another agent needs a Settings row of its own.
 */
export function createClaudeLaunchHost(ctx: LaunchHostContext) {
  /** Where the person's own Claude files are: their HOME and CLAUDE_CONFIG_DIR (the last shell read's, else the Inbox's). */
  const claudeFiles = () => {
    const configDir = ctx.shell()?.CLAUDE_CONFIG_DIR ?? ctx.ownEnv().CLAUDE_CONFIG_DIR;
    return createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env: configDir ? { CLAUDE_CONFIG_DIR: configDir } : {} });
  };
  const cli = createClaudeHost({ environment: ctx.environment, files: claudeFiles });
  /** The person's own Claude setup (bypass consent, a bypass disable, their default mode), read from their files now; `folder` adds that project's settings. */
  const claudeSetup = (folder: string | null = null) => claudeBypassSetup(claudeFiles(), folder);
  /** How a launch made now would start (`launchStartOf`), from the switch, the person's Claude setup and the last shell read. */
  const startNow = (setup: ReturnType<typeof claudeSetup>) =>
    launchStartOf({ setting: ctx.config().fullPermissions, defaultMode: setup.defaultMode, shellSkips: shellSkipsPermissions(ctx.shell()), consent: setup.consent, disabled: setup.disabled });
  /** The folder a start failure names and Open in Terminal trusts: a scratch launch's root, unless it became a repository. */
  const trustFolderOf = cli.trustFolder;
  /** A launch's `--permission-mode`: bypass for full permissions, none for the person's own default mode, else auto. */
  const modeOf = (launch: InboxLaunchRecord): ClaudeLaunchMode => (inboxLaunchFullPermissions(launch) ? "bypassPermissions" : launch.own_mode ? null : "auto");

  /**
   * The launch's settings file. Every launch, full included, has the permission hook: whatever Claude still
   * asks (bypass mode's safety checks; every prompt when Claude declined bypass) comes to a card, never to a
   * Terminal dialog no one sees. An auto launch pins `defaultMode: "default"`: when Claude drops auto mode
   * (its killswitch, a CLI without it) the session lands in default mode, never in the person's own bypass.
   */
  const writeSettings = (launch: InboxLaunchRecord, login: LaunchEnv, model: string | null): string => {
    const fullPermissions = inboxLaunchFullPermissions(launch);
    const dir = ctx.launchDir(launch.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "settings.json");
    const isDefaultDataDir = resolve(ctx.dataDir) === resolve(getDefaultPlannotatorDataDir(ctx.homeDir));
    const settings = {
      ...(model ? { model } : {}),
      env: launchSettingsEnv(login, {
        launchId: launch.id,
        key: randomBytes(32).toString("hex"),
        dataDir: isDefaultDataDir ? null : ctx.dataDir,
        fullPermissions,
        bypassAvailable: launch.bypass_available === true,
      }),
      permissions: { allow: [INBOX_TOOL_PERMISSION], ...(modeOf(launch) === "auto" ? { defaultMode: "default" } : {}) },
      // Permission prompts come to the launch thread as questions (inbox-launch-claude-permission.ts).
      hooks: launchPermissionHooks(ctx.selfCommand),
    };
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };

  return {
    agent: CLAUDE,
    name: CLAUDE_NAME,
    // Of a login-shell read: its CLAUDE_CONFIG_DIR (where the person's Claude files are) and the skip-permissions export.
    shellNames: ["CLAUDE_CONFIG_DIR", CLAUDE_SKIP_PERMISSIONS_ENV],

    /** `claude` on the plain env's PATH (the Inbox's, the last login PATH, Claude's install folders), new enough, the plugin's mod and its Inbox tool on. */
    async available(): Promise<LaunchAvailability> {
      const e = await ctx.environment();
      const path = e.which("claude");
      if (!path) return { ok: false, missing: true, reason: "claude is not on the Inbox's PATH or in ~/.local/bin or ~/.claude/local" };
      const version = parseClaudeVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
      if (!version || !versionAtLeast(version, CLAUDE_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `Claude Code ${version ?? "?"} is older than ${CLAUDE_LAUNCH_MIN_VERSION}` };
      if (!claudeCodePluginEnabled(e) || !claudeCodeInboxToolOn(e)) return { ok: false, missing: false, reason: "Plannotator's Claude Code plugin or its Inbox tool is off" };
      return { ok: true, version };
    },

    /** The switch, the person's own Claude setup (with this folder's settings) and the last finished shell read. */
    startOf: (folder: string) => startNow(claudeSetup(folder)),

    /** Claude Code trusts the folder (or one above it), so every scratch folder in it starts without a trust prompt. */
    trusts: cli.trusts,

    /**
     * The settings file, then `claude --bg`. How it starts comes from the launch record (fixed when it was
     * made), never the live switch or shell: a Try again after either changed starts the session the card
     * describes. Full permissions: bypass mode; the person's own default mode: no flag; otherwise auto mode.
     */
    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      const settingsPath = writeSettings(launch, input.login, ctx.config().model);
      const result = await cli.start({
        folder: launch.folder,
        shownFolder: ctx.displayFolder(trustFolderOf(launch)),
        name: input.name,
        settingsPath,
        mode: modeOf(launch),
        allowBypass: launch.bypass_available === true,
        environment: createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env: launchSpawnEnv(input.login) }),
      });
      ctx.startLog(launch.id, result.output);
      if (result.modeRefused) {
        ctx.startLog(launch.id, `auto mode refused, started in default mode: ${result.modeRefused}`);
        ctx.log(`Inbox launch ${launch.id}: auto mode refused (${result.modeRefused}); started in default mode`);
      }
      return result.ok ? { ok: true as const, session: result.session, ref: result.short } : { ok: false as const, code: result.missing ? ("missing" as const) : result.code, text: result.text };
    },

    /** `claude agents --json --all`: a session by its short id, or the one whose full id it prefixes. */
    async sessions() {
      const agents = await cli.agents();
      if (!agents) return null;
      return (ref: string) => {
        const agent = agents.find((a) => a.id === ref || a.sessionId.startsWith(ref));
        return agent ? { status: agent.status, state: agent.state, waitingFor: agent.waitingFor } : ("absent" as const);
      };
    },

    /** The mod's bridge poll. */
    live: (session: string) => ctx.bridge.runStateOf(session),

    /** `claude respawn <short>`: a pending reply is delivered once it connects. Claude checks trust here too. */
    async resume(launch: InboxLaunchRecord) {
      const result = await cli.respawn(launch.session_ref!);
      return { ...resultOf(result), failure: result.exitCode === 0 ? null : startFailureOf(result, ctx.displayFolder(trustFolderOf(launch))) };
    },
    stop: async (ref: string) => resultOf(await cli.stop(ref)),
    remove: async (ref: string) => resultOf(await cli.rm(ref)),
    /** Not in a folder inside a repository: there `claude purge` would drop the repository's own entry too. */
    purge: async (folder: string) => {
      const result = await cli.purge(folder);
      return { ...resultOf(result), ...(result.skipped ? { skipped: result.skipped } : {}) };
    },

    attach: (launch: InboxLaunchRecord) => (launch.session_ref ? claudeAttachCommand(launch.folder, launch.session_ref) : null),
    /** A start or restart Claude refused for trust: plain `claude` where trust is keyed, so its trust prompt shows. */
    terminal: (launch: InboxLaunchRecord, untrusted: boolean) =>
      launch.session_ref && !untrusted ? claudeAttachCommand(launch.folder, launch.session_ref) : claudeTrustCommand(trustFolderOf(launch)),

    permissions: createLaunchPermissions,

    /**
     * Settings → Agents' switch: the person's choice once set; never set, what their own setup says
     * (`follows`: on because their Claude settings or their shell run Claude in bypass mode). `own_mode`: a
     * launch starts in their own default mode; `bypass_off`: they want full permissions, and Claude Code's
     * settings turn bypass mode off (`disableBypassPermissionsMode`); `needs_consent`: they want them, and Claude Code's
     * bypass notice is not accepted on this computer, so a launch starts without them. It uses the last shell read.
     */
    settingsState() {
      const setting = ctx.config().fullPermissions;
      const setup = claudeSetup();
      const start = startNow(setup);
      const follows = setting === null && start.wantsFull ? (setup.defaultMode === "bypassPermissions" ? "claude" : "shell") : null;
      return {
        full_permissions: setting ?? start.wantsFull,
        follows,
        own_mode: start.ownMode,
        bypass_off: start.wantsFull && setup.disabled,
        needs_consent: start.wantsFull && !setup.disabled && !setup.consent,
      };
    },
  } satisfies LaunchHost & { settingsState(): unknown };
}
