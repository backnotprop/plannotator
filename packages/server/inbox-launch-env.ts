/**
 * The environment of an agent the Inbox starts (launch; PLAN "Claude: start,
 * env, permissions" 5 and 6).
 *
 * The Inbox may itself have been started by an agent session, so its own env
 * carries that session's markers. A launched agent instead gets the person's
 * LOGIN shell env: `$SHELL -ilc`, printed with `env -0` between markers,
 * 5 s at most, cached 60 s, read again on each launch (never on respawn).
 *
 * - `launchSpawnEnv`: the env every `claude` call runs with. Our call may be
 *   the one that starts the person's shared supervisor, whose env every later
 *   background session inherits, so the Inbox's own markers and data dir are
 *   dropped. Unlike `askAiChildEnv`, the Inbox stays ON for a launched agent.
 * - `launchSettingsEnv`: what goes in the per-launch settings FILE's `env`
 *   (reaches only our session, survives respawn, never shows in `ps`).
 *
 * Variable values are never logged; only names.
 */

/** Dropped from every spawn: the markers of whichever session started the Inbox, and the Inbox's own data dir. */
export const LAUNCH_SPAWN_DROP = [
  "PLANNOTATOR_SESSION_TAG",
  "PLANNOTATOR_INBOX_REMINDER",
  "PLANNOTATOR_ASK_AI_CHILD",
  "PLANNOTATOR_INBOX_TOOL",
  "PLANNOTATOR_AGENT_TOOL",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_THREAD_ID",
  "PLANNOTATOR_DATA_DIR",
] as const;

/** `CLAUDE_*` names Claude sets per session: never copied into a launch's settings. */
const PER_SESSION_CLAUDE = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_.*|CLAUDE_JOB_DIR|CLAUDE_PROJECT_DIR|CLAUDE_CODE_MESSAGING_.*)$/;

/** Claude Code's own switch for bypass mode without the acceptance dialog. */
export const CLAUDE_SKIP_PERMISSIONS_ENV = "CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS";

export type LaunchEnv = Record<string, string>;

export function launchSpawnEnv(login: Readonly<LaunchEnv>): LaunchEnv {
  const out: LaunchEnv = { ...login };
  for (const name of LAUNCH_SPAWN_DROP) delete out[name];
  return out;
}

export function launchSettingsEnv(
  login: Readonly<LaunchEnv>,
  input: { launchId: string; key: string; dataDir: string | null; fullPermissions: boolean },
): LaunchEnv {
  const out: LaunchEnv = {};
  for (const [name, value] of Object.entries(login)) {
    if (name.startsWith("CLAUDE_") && !PER_SESSION_CLAUDE.test(name)) out[name] = value;
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

/**
 * The person's login-shell env, cached `ttlMs`. When the shell cannot be read
 * in time, the Inbox's own env stands in (the spawn filter still drops the
 * session markers) and the cause is logged once per read.
 */
export function createLoginEnv(options: {
  run: LoginEnvRunner;
  env: () => Readonly<Record<string, string | undefined>>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 60_000;
  let cached: { at: number; env: LaunchEnv } | null = null;
  const plain = (): LaunchEnv => Object.fromEntries(Object.entries(options.env()).filter((e): e is [string, string] => typeof e[1] === "string"));
  return async (): Promise<LaunchEnv> => {
    if (cached && now() - cached.at < ttl) return cached.env;
    const own = plain();
    const shell = own.SHELL || "/bin/sh";
    let env: LaunchEnv | null = null;
    try {
      const result = await options.run([shell, "-ilc", `printf '${MARK}'; env -0; printf '${MARK}'`], { timeoutMs: options.timeoutMs ?? 5000, env: own });
      env = result.exitCode === 0 ? parseMarkedEnv(result.stdout) : null;
    } catch {
      env = null;
    }
    if (!env) options.log?.(`Inbox launch: could not read the login shell's env (${shell}); using the Inbox's own.`);
    else options.log?.(`Inbox launch: login env read, ${Object.keys(env).length} names: ${Object.keys(env).filter((n) => n.startsWith("CLAUDE")).join(" ") || "no CLAUDE_*"}`);
    cached = { at: now(), env: env ?? own };
    return cached.env;
  };
}
