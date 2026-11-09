/**
 * The environment of an agent the Inbox starts (launch; PLAN "Claude: start,
 * env, permissions" 5 and 6).
 *
 * The Inbox may itself have been started by an agent session, so its own env
 * carries that session's markers. A launched agent instead gets the person's
 * LOGIN shell env: `$SHELL -ilc`, printed with `env -0` between markers, 5 s
 * at most: once when the Inbox starts, ahead when the composer picks "Start
 * Claude Code", for Settings → Agents while the switch was never set, and by
 * each start or restart for its own env; never for a status read or a stop. The shell starts from the Inbox's env through
 * `launchSpawnEnv`, so what launchd and the session give (SSH_AUTH_SOCK,
 * `launchctl setenv` proxies, LC_*) stays, and the Inbox's markers do not.
 *
 * - `launchSpawnEnv`: the env a `claude` call runs with. Our call may be the
 *   one that starts the person's shared supervisor, whose env every later
 *   background session inherits, so no `PLANNOTATOR_*` name, no per-session
 *   Claude marker and no skip-permissions export passes (a full launch is
 *   bypass by its `--permission-mode`, never by the export). The person's own `CLAUDE_*`
 *   settings (CLAUDE_CONFIG_DIR) stay. Unlike `askAiChildEnv`, the Inbox stays
 *   ON for a launched agent: its settings file says where the Inbox is.
 * - `launchPlainEnv`: every call but a start or restart (status, stop, rm,
 *   `--version`): the Inbox's own env through the same filter, with extra
 *   PATH folders.
 * - `launchSettingsEnv`: what goes in the per-launch settings FILE's `env`
 *   (reaches only our session, survives respawn, never shows in `ps`): the
 *   login shell's `CLAUDE_*` values and PATH, never the rest of it.
 *
 * Variable values are never logged; only names.
 */

/**
 * `CLAUDE_*` names Claude sets inside a running session (an Inbox started
 * from one has them): never passed on, never copied into a launch's settings,
 * or the launched agent could attach to that session.
 */
const PER_SESSION_CLAUDE =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_SESSION_.*|CLAUDE_JOB_DIR|CLAUDE_PROJECT_DIR|CLAUDE_CODE_MESSAGING_.*)$/;
import { userInfo } from "node:os";
import { INBOX_LAUNCH_FULL_PERMISSIONS_ENV } from "@plannotator/core/inbox-permission";

/**
 * Never in a spawn: every Plannotator name (markers, data dir, ports, test switches), the other hosts' session
 * markers (an Inbox started from inside a Pi session has Pi's: its session, its file, its model).
 */
const SPAWN_DROP = /^(PLANNOTATOR_.*|CODEX_THREAD_ID|PI_SESSION_ID|PI_SESSION_FILE|PI_PROVIDER|PI_MODEL|PI_REASONING_LEVEL)$/;

/** Claude Code's own switch for bypass mode without the acceptance dialog. */
export const CLAUDE_SKIP_PERMISSIONS_ENV = "CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS";

export type LaunchEnv = Record<string, string>;

/** Whether an env turns Claude Code's bypass mode on (the skip-permissions export set to a true value, as Claude reads it). */
export function shellSkipsPermissions(env: Readonly<LaunchEnv> | null): boolean {
  const value = env?.[CLAUDE_SKIP_PERMISSIONS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * How a launch starts, fixed on its record when it is made (`full_permissions`, `own_mode`,
 * `bypass_available`). In order: Settings → Agents' switch once the person set it (on: full; off: auto);
 * never set, their own Claude `permissions.defaultMode` (bypass: full; any other: that mode, no
 * `--permission-mode`), then their login shell's skip-permissions export (full), then auto mode.
 * Full needs the person's own recorded bypass consent (Claude ignores bypass in a background session
 * without it): without it a full launch starts in their own mode or auto. `bypass` says whether the
 * session may switch to bypass later (the card's Full permissions).
 */
export function launchStartOf(input: {
  setting: boolean | null;
  defaultMode: string | null;
  shellSkips: boolean;
  consent: boolean;
  disabled: boolean;
}): { full: boolean; wantsFull: boolean; ownMode: boolean; bypass: boolean } {
  const bypass = input.consent && !input.disabled;
  const own = input.defaultMode !== null && input.defaultMode !== "bypassPermissions";
  const wantsFull = input.setting ?? (input.defaultMode === "bypassPermissions" || (!own && input.shellSkips));
  const full = wantsFull && bypass;
  // Their own mode whenever the launch is not full: the switch off never widens an ask-every-time person to auto.
  return { full, wantsFull, ownMode: !full && own, bypass };
}

/**
 * `env` without Plannotator's names, Claude's per-session ones and the skip-permissions export: never
 * passed, a full launch included (its bypass is `--permission-mode bypassPermissions`; the export would be
 * inert anyway, as Claude ignores it while any PermissionRequest hook exists, the plugin's included).
 */
export function launchSpawnEnv(env: Readonly<LaunchEnv>): LaunchEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SPAWN_DROP.test(name) && !PER_SESSION_CLAUDE.test(name) && name !== CLAUDE_SKIP_PERMISSIONS_ENV));
}

/** The Inbox's own env for the calls that are not a start: the same filter, `extraPath` after its PATH. */
export function launchPlainEnv(own: Readonly<Record<string, string | undefined>>, extraPath: readonly string[] = []): LaunchEnv {
  const out = launchSpawnEnv(stringsOf(own));
  const path = [...(out.PATH ?? "").split(":"), ...extraPath].filter(Boolean);
  out.PATH = [...new Set(path)].join(":");
  return out;
}

const stringsOf = (env: Readonly<Record<string, string | undefined>>): LaunchEnv =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));

export function launchSettingsEnv(
  login: Readonly<LaunchEnv>,
  input: { launchId: string; key: string; dataDir: string | null; fullPermissions: boolean; bypassAvailable: boolean },
): LaunchEnv {
  const out: LaunchEnv = {};
  for (const [name, value] of Object.entries(login)) {
    // Bypass mode comes from the launch record alone (`launchStartOf`), never copied from the shell.
    if (name.startsWith("CLAUDE_") && !PER_SESSION_CLAUDE.test(name) && name !== CLAUDE_SKIP_PERMISSIONS_ENV) out[name] = value;
  }
  // A session gets its supervisor's env, whoever started that: the file is the one way the login PATH reaches it.
  if (login.PATH) out.PATH = login.PATH;
  if (input.dataDir) out.PLANNOTATOR_DATA_DIR = input.dataDir;
  out.PLANNOTATOR_LAUNCH = input.launchId;
  out.PLANNOTATOR_LAUNCH_KEY = input.key;
  // A launch that may switch to bypass later (the person's consent recorded): its permission hook honours Full permissions.
  if (input.bypassAvailable && !input.fullPermissions) out[INBOX_LAUNCH_FULL_PERMISSIONS_ENV] = "1";
  return out;
}

const MARK = "__PLANNOTATOR_LAUNCH_ENV__";

/** `env -0` output between the two markers, as a map. Null when the markers are missing. */
export function parseMarkedEnv(stdout: string): LaunchEnv | null {
  const start = stdout.indexOf(MARK);
  const end = stdout.lastIndexOf(MARK);
  if (start < 0 || end <= start) return null;
  const out: LaunchEnv = {};
  for (const entry of stdout.slice(start + MARK.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

export interface LoginEnvRunner {
  (argv: string[], options: { timeoutMs: number; env: Readonly<Record<string, string | undefined>> }): Promise<{ exitCode: number; stdout: string }>;
}

function accountShell(): string | null {
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
}

/** The env the login shell starts from: the Inbox's own through the spawn filter (no whitelist: SSH_AUTH_SOCK and the like stay). */
export function loginSeedEnv(own: Readonly<Record<string, string | undefined>>): LaunchEnv {
  return launchSpawnEnv(stringsOf(own));
}

/**
 * Read the person's login-shell env, once per call (one launch). It starts
 * from `loginSeedEnv`. When the shell cannot be read in time, the Inbox's
 * plain env stands in, and the cause is logged.
 */
export function createLoginEnv(options: {
  run: LoginEnvRunner;
  env: () => Readonly<Record<string, string | undefined>>;
  /** The account's own login shell, for an Inbox started without SHELL in its env. */
  accountShell?: () => string | null;
  timeoutMs?: number;
  log?: (line: string) => void;
}) {
  return async (): Promise<LaunchEnv> => {
    const own = options.env();
    const seed = loginSeedEnv(own);
    const shell = seed.SHELL || (options.accountShell ?? accountShell)() || "/bin/sh";
    let env: LaunchEnv | null = null;
    try {
      const result = await options.run([shell, "-ilc", `printf '${MARK}'; env -0; printf '${MARK}'`], { timeoutMs: options.timeoutMs ?? 5000, env: seed });
      env = result.exitCode === 0 ? parseMarkedEnv(result.stdout) : null;
    } catch {
      env = null;
    }
    if (!env) options.log?.(`Inbox launch: could not read the login shell's env (${shell}); using the Inbox's own.`);
    else options.log?.(`Inbox launch: login env read, ${Object.keys(env).length} names: ${Object.keys(env).filter((n) => n.startsWith("CLAUDE")).join(" ") || "no CLAUDE_*"}`);
    return env ?? launchPlainEnv(own);
  };
}
