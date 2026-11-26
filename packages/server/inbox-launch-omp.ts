/**
 * Oh My Pi as a `LaunchHost`: "New Oh My Pi session" in compose's To (#3443). Oh My Pi (`omp`) is built on Pi and
 * loads Plannotator's Pi extension through its Pi compatibility layer, so it is the Pi launcher (inbox-launch-pi.ts)
 * with its own flavor: the same process the Inbox owns (`omp --mode rpc`, stdin held open; RPC mode ends when stdin
 * closes), the same RPC (`get_state`, `abort`, the extension's dialogs answered Cancel), Stop, one writer per session
 * and Open in Terminal's hand-off. Its sessions poll this Inbox as host `pi` (`plugin.host: "oh-my-pi"`), so the
 * root's `to.host` is `pi` (`sessionHost`) and the window names them Oh My Pi from the launch and the runtime.
 *
 * What differs:
 * - The session id is Oh My Pi's own (a UUIDv7; it takes none on argv): read from `get_state` once it is up, and the
 *   thread's name is set over RPC (`set_session_name`; it has no `--name`). A reply to a stopped session starts
 *   `omp --mode rpc --resume <id>`, which reopens its session file with the whole conversation. Oh My Pi writes that
 *   file from its first answer on, so a session stopped before it ever answered has nothing to continue: the
 *   restart says so instead of starting an empty one under another id.
 * - The extension is read from Oh My Pi's plugin record (`omp plugin install` writes it): the plugins folder's
 *   `package.json` lists the package in `dependencies`, and `omp-plugins.lock.json` does not turn it off. A
 *   `settings.json` `extensions` entry in its agent dir counts too.
 * - `--allow-home`: Oh My Pi moves a session started in the home folder to a temp folder; the Inbox starts it where
 *   the person picked.
 * - No model or effort menus and no Rex tab yet; it starts in the background only.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { INBOX_OMP_EXTENSION_INSTALL } from "@plannotator/core/inbox-launch-ready";
import { createPiLaunchHost, piExtensionListed, piStoppedNote, type PiLaunchFlavor } from "./inbox-launch-pi";
import type { LaunchHost, LaunchHostContext } from "./inbox-launch-host";

export const OMP = "oh-my-pi" as const;
export const OMP_NAME = "Oh My Pi";
/** The Oh My Pi this was built and checked against (its RPC `get_state`, `set_session_name`, `--resume <id>`). */
export const OMP_LAUNCH_MIN_VERSION = "19.2.1";
/** The extension's package, as Oh My Pi's plugin record names it. */
const EXTENSION = "@plannotator/pi-extension";
/**
 * Why it can't start here, as this computer's refusal puts it ("Oh My Pi can't be started here: <this>. Nothing was
 * sent."): the same fix a linked machine's line gives (`inboxLaunchNotReadyWords`, `plugin_off`).
 */
export const OMP_NOT_INSTALLED = `Plannotator's Pi extension isn't installed for it. Run \`${INBOX_OMP_EXTENSION_INSTALL}\` on this computer, then try again`;
/** The stopped line after an Inbox restart. */
export const OMP_STOPPED_NOTE = piStoppedNote(OMP_NAME);

type Env = (name: string) => string | undefined;

/** `PI_CONFIG_DIR` (the folder name under home, `.omp` by default) and `OMP_PROFILE` / `PI_PROFILE`: Oh My Pi's config root. */
function ompConfigRoot(env: Env, home: string): string {
  const root = join(home, env("PI_CONFIG_DIR") || ".omp");
  const profile = (env("OMP_PROFILE") ?? env("PI_PROFILE"))?.trim();
  return profile && /^[\w.-]+$/.test(profile) ? join(root, "profiles", profile) : root;
}

/** Oh My Pi's agent dir: `PI_CODING_AGENT_DIR` (the default profile only), else `<config root>/agent`. */
export function ompAgentDir(env: Env, home: string): string {
  const profiled = !!(env("OMP_PROFILE") ?? env("PI_PROFILE"))?.trim();
  const override = profiled ? undefined : env("PI_CODING_AGENT_DIR");
  return override ? resolve(override) : join(ompConfigRoot(env, home), "agent");
}

/** Where `omp plugin install` keeps its record: `$XDG_DATA_HOME/omp/plugins` once that folder exists (macOS and Linux), else `<config root>/plugins`. */
export function ompPluginsDirs(env: Env, home: string, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  const xdg = env("XDG_DATA_HOME");
  const profiled = !!(env("OMP_PROFILE") ?? env("PI_PROFILE"))?.trim();
  if (xdg && !profiled && (platform === "darwin" || platform === "linux") && existsSync(join(xdg, "omp"))) out.push(join(xdg, "omp", "plugins"));
  out.push(join(ompConfigRoot(env, home), "plugins"));
  return out;
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * Whether Oh My Pi's plugin record in `dir` has Plannotator's Pi extension: `package.json` lists it in `dependencies`
 * (`bun install <spec>` there, as `omp plugin install` runs it), and `omp-plugins.lock.json` does not turn it off
 * (`plugins[name].enabled: false`, `omp plugin disable`).
 */
export function ompPluginInstalled(dir: string): boolean {
  const deps = readJson(join(dir, "package.json"))?.dependencies;
  if (!deps || typeof deps !== "object" || !Object.hasOwn(deps, EXTENSION)) return false;
  const lock = readJson(join(dir, "omp-plugins.lock.json"))?.plugins as Record<string, { enabled?: unknown }> | undefined;
  return lock?.[EXTENSION]?.enabled !== false;
}

/**
 * Oh My Pi's default sessions folder for `cwd` (its `computeDefaultSessionDir`): under the temp root `-tmp-<relative>`,
 * under home `-<relative>`, anywhere else `--<absolute>--`, each separator a `-`.
 */
export function ompSessionDirOf(agentDir: string, cwd: string, home: string, temp: string = tmpdir()): string {
  const at = resolve(cwd);
  // Oh My Pi compares canonical paths (links resolved), so the roots are taken as they really are.
  const real = (dir: string) => {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  };
  const within = (root: string) => {
    const rel = relative(real(root), at);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : null;
  };
  const encode = (prefix: string, rel: string) => {
    const encoded = rel.replace(/[/\\:]/g, "-");
    return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
  };
  const inTemp = within(temp);
  const inHome = within(home);
  const name = inTemp !== null ? encode("-tmp", inTemp) : inHome !== null ? encode("-", inHome) : `--${at.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", name);
}

export const OMP_FLAVOR: PiLaunchFlavor = {
  agent: OMP,
  name: OMP_NAME,
  bin: "omp",
  minVersion: OMP_LAUNCH_MIN_VERSION,
  shellNames: ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME", "TMPDIR"],
  ids: "agent",
  argv: (path, session) => [path, "--mode", "rpc", "--allow-home", ...(session ? ["--resume", session] : [])],
  // `--session` and `-r` are its other names for `--resume`.
  sessionFlag: "--resume|--session|-r",
  terminalArgs: (session) => ["omp", "--resume", session],
  agentDir: ompAgentDir,
  extension: (env, home, agentDir) => {
    if (ompPluginsDirs(env, home).some(ompPluginInstalled)) return { ok: true };
    let settings: string | null = null;
    try {
      settings = readFileSync(join(agentDir, "settings.json"), "utf8");
    } catch {}
    return piExtensionListed(settings) ? { ok: true } : { ok: false, reason: OMP_NOT_INSTALLED, code: "plugin_off" };
  },
  // Its temp root is the one its process sees: the login's TMPDIR, else /tmp (the folder's header decides what goes).
  sessionDirs: (agentDir, cwd, home, env) => [...new Set([env("TMPDIR"), tmpdir(), "/tmp"].filter((t): t is string => !!t).map((temp) => ompSessionDirOf(agentDir, cwd, home, temp)))],
  choices: false,
};

/** Oh My Pi's host: the Pi launcher with its flavor, its sessions as host `pi`, and no menus or Rex start (not yet). */
export function createOhMyPiLaunchHost(ctx: LaunchHostContext, options: Parameters<typeof createPiLaunchHost>[1] = {}): LaunchHost {
  const { choices: _choices, rexCommand: _rex, runsSession: _runs, sessionPids: _pids, ...host } = createPiLaunchHost(ctx, options, OMP_FLAVOR);
  return { ...host, sessionHost: "pi" };
}
