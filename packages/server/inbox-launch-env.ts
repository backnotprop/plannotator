/**
 * The environment of an agent the Inbox starts (launch; PLAN "Claude: start,
 * env, permissions" 5 and 6).
 *
 * The Inbox may itself have been started by an agent session, so its own env
 * carries that session's markers. A launched agent instead gets the person's
 * LOGIN shell env: `$SHELL -ilc`, printed with `env -0` between markers, 5 s
 * at most, read once per launch and at no other time (never for a status
 * read, a stop or a respawn). The shell starts from a minimal env, so nothing
 * of the Inbox's own reaches it.
 *
 * - `launchSpawnEnv`: the env a `claude` call runs with. Our call may be the
 *   one that starts the person's shared supervisor, whose env every later
 *   background session inherits, so no `PLANNOTATOR_*` name and no
 *   per-session Claude marker passes. Unlike `askAiChildEnv`, the Inbox stays
 *   ON for a launched agent: its settings file says where the Inbox is.
 * - `launchPlainEnv`: every call but the start (status, stop, respawn, rm,
 *   `--version`): the Inbox's own env through the same filter, minus every
 *   `CLAUDE*` name (those came from whichever session started the Inbox).
 * - `launchSettingsEnv`: what goes in the per-launch settings FILE's `env`
 *   (reaches only our session, survives respawn, never shows in `ps`).
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
/** Never in a spawn: every Plannotator name (markers, data dir, ports, test switches), the other hosts' session markers. */
const SPAWN_DROP = /^(PLANNOTATOR_.*|CODEX_THREAD_ID)$/;

/** The login shell starts from these alone (and a plain PATH): nothing of the Inbox's own env reaches it. */
const LOGIN_SEED = ["HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG"] as const;

/** Claude Code's own switch for bypass mode without the acceptance dialog. */
export const CLAUDE_SKIP_PERMISSIONS_ENV = "CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS";

export type LaunchEnv = Record<string, string>;

export function launchSpawnEnv(env: Readonly<LaunchEnv>): LaunchEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SPAWN_DROP.test(name) && !PER_SESSION_CLAUDE.test(name)));
}

/** The Inbox's own env for the calls that are not a start: filtered, no `CLAUDE*` at all, `extraPath` after its PATH. */
export function launchPlainEnv(own: Readonly<Record<string, string | undefined>>, extraPath: readonly string[] = []): LaunchEnv {
  const out = Object.fromEntries(Object.entries(launchSpawnEnv(stringsOf(own))).filter(([name]) => !name.startsWith("CLAUDE")));
  const path = [...(out.PATH ?? "").split(":"), ...extraPath].filter(Boolean);
  out.PATH = [...new Set(path)].join(":");
  return out;
}

const stringsOf = (env: Readonly<Record<string, string | undefined>>): LaunchEnv =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));

export function launchSettingsEnv(
  login: Readonly<LaunchEnv>,
  input: { launchId: string; key: string; dataDir: string | null; fullPermissions: boolean },
): LaunchEnv {
  const out: LaunchEnv = {};
  for (const [name, value] of Object.entries(login)) {
    // Bypass mode comes from the Settings switch alone, never from a shell export.
    if (name.startsWith("CLAUDE_") && !PER_SESSION_CLAUDE.test(name) && name !== CLAUDE_SKIP_PERMISSIONS_ENV) out[name] = value;
  }
  if (input.dataDir) out.PLANNOTATOR_DATA_DIR = input.dataDir;
  out.PLANNOTATOR_LAUNCH = input.launchId;
  out.PLANNOTATOR_LAUNCH_KEY = input.key;
  if (input.fullPermissions) out[CLAUDE_SKIP_PERMISSIONS_ENV] = "1";
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

/** The env the login shell starts from: the seed names of the Inbox's env, and PATH=/usr/bin:/bin. */
export function loginSeedEnv(own: Readonly<Record<string, string | undefined>>): LaunchEnv {
  const out: LaunchEnv = { PATH: "/usr/bin:/bin" };
  for (const name of LOGIN_SEED) if (typeof own[name] === "string") out[name] = own[name]!;
  return out;
}

/**
 * Read the person's login-shell env, once per call (one launch). It starts
 * from `loginSeedEnv`. When the shell cannot be read in time, the Inbox's
 * plain env stands in, and the cause is logged.
 */
export function createLoginEnv(options: {
  run: LoginEnvRunner;
  env: () => Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  log?: (line: string) => void;
}) {
  return async (): Promise<LaunchEnv> => {
    const own = options.env();
    const seed = loginSeedEnv(own);
    const shell = seed.SHELL || "/bin/sh";
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
