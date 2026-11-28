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
 *   restart says so instead of starting an empty one under another id, and so does the stopped line.
 * - A new start must be a new session: with its Auto Resume setting on, Oh My Pi reopens the newest session in the
 *   folder instead (in RPC mode too). Then the Inbox asks it for a new one (RPC `new_session`) and refuses, with
 *   nothing sent, when it still is not new.
 * - `--resume <id>` may answer as a newer copy of the conversation (another id): the thread moves to it when its
 *   header leads back to the thread's session, and is refused once, for good, when it does not.
 * - The extension is read from Oh My Pi's plugin record (`omp plugin install` writes it): the plugins folder's
 *   `package.json` lists the package in `dependencies`, or `omp plugin link` linked a checkout (a lock entry and a
 *   link in `node_modules`), and `omp-plugins.lock.json` does not turn it off. A `settings.json` `extensions` entry in
 *   its agent dir counts too.
 * - `--allow-home`: Oh My Pi moves a session started in the home folder to a temp folder; the Inbox starts it where
 *   the person picked.
 * - No model or effort menus and no Rex tab yet; it starts in the background only.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
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

/**
 * A profile name as Oh My Pi takes it (utils dirs.ts `normalizeProfileName`): trimmed; "" and "default" are the
 * default profile; one it would refuse counts as the default too, as its startup reads it (`readProfileFromEnvSafe`).
 */
function ompProfileName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || name === "default" || name.endsWith(".") || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return undefined;
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name) ? undefined : name;
}

/** The profile in use: `OMP_PROFILE` when it is set at all (even empty: the default), else `PI_PROFILE` (dirs.ts `resolveProfileEnv`). */
function ompProfile(env: Env): string | undefined {
  const omp = env("OMP_PROFILE");
  return ompProfileName(omp !== undefined ? omp : env("PI_PROFILE"));
}

/** `~/<PI_CONFIG_DIR or .omp>`, and `/profiles/<name>` under it for a profile: Oh My Pi's config root. */
function ompConfigRoot(env: Env, home: string, profile = ompProfile(env)): string {
  const root = join(home, env("PI_CONFIG_DIR") || ".omp");
  return profile ? join(root, "profiles", profile) : root;
}

/**
 * Oh My Pi's agent dir: `<config root>/agent`, or in the default profile `PI_CODING_AGENT_DIR` unless that is the agent dir
 * `PI_PROFILE` derives (a parent's profile, passed down: dirs.ts `resolvePreProfileAgentDir`).
 */
export function ompAgentDir(env: Env, home: string): string {
  const profile = ompProfile(env);
  if (profile) return join(ompConfigRoot(env, home, profile), "agent");
  const override = env("PI_CODING_AGENT_DIR");
  const piProfile = ompProfileName(env("PI_PROFILE"));
  if (override && !(piProfile && override === join(ompConfigRoot(env, home, piProfile), "agent"))) return resolve(override);
  return join(ompConfigRoot(env, home), "agent");
}

/**
 * Oh My Pi's XDG data root (dirs.ts `DirResolver`), or null: on macOS and Linux, with its agent dir the default one,
 * `$XDG_DATA_HOME/omp` (a profile's `$XDG_DATA_HOME/omp/profiles/<name>`) once that folder exists.
 */
function ompXdgData(env: Env, home: string, platform: NodeJS.Platform): string | null {
  const xdg = env("XDG_DATA_HOME");
  if (!xdg || (platform !== "darwin" && platform !== "linux")) return null;
  const profile = ompProfile(env);
  if (ompAgentDir(env, home) !== join(ompConfigRoot(env, home, profile), "agent")) return null;
  const root = profile ? join(xdg, "omp", "profiles", profile) : join(xdg, "omp");
  return existsSync(root) ? root : null;
}

/** Where `omp plugin install` keeps its record (dirs.ts `getPluginsDir`): `<XDG data root>/plugins`, else `<config root>/plugins`. */
export function ompPluginsDirs(env: Env, home: string, platform: NodeJS.Platform = process.platform): string[] {
  const xdg = ompXdgData(env, home, platform);
  return [...(xdg ? [join(xdg, "plugins")] : []), join(ompConfigRoot(env, home), "plugins")];
}

/** Oh My Pi's sessions root (dirs.ts `getSessionsDir`): `<XDG data root>/sessions` (XDG drops the `agent/`), else `<agent dir>/sessions`. */
export function ompSessionsRoot(env: Env, home: string, platform: NodeJS.Platform = process.platform): string {
  const xdg = ompXdgData(env, home, platform);
  return xdg ? join(xdg, "sessions") : join(ompAgentDir(env, home), "sessions");
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
 * Whether Oh My Pi's plugin record in `dir` has Plannotator's Pi extension, as its loader decides (coding-agent
 * extensibility/plugins/loader.ts): `package.json` lists it in `dependencies` (`bun install <spec>` there, as `omp
 * plugin install` runs it), or `omp-plugins.lock.json` names it and `node_modules` links it (`omp plugin link` links a
 * checkout there and adds no dependency; with a `package.json` there the entry must be that link, and a link to nothing
 * does not count); and the lock does not turn it off (`plugins[name].enabled: false`, `omp plugin disable`).
 */
export function ompPluginInstalled(dir: string): boolean {
  const manifest = join(dir, "package.json");
  const deps = readJson(manifest)?.dependencies;
  const lock = readJson(join(dir, "omp-plugins.lock.json"))?.plugins as Record<string, { enabled?: unknown }> | undefined;
  const listed = !!deps && typeof deps === "object" && Object.hasOwn(deps, EXTENSION);
  if (!listed && !(lock && typeof lock === "object" && Object.hasOwn(lock, EXTENSION) && ompPluginLinked(dir, existsSync(manifest)))) return false;
  return lock?.[EXTENSION]?.enabled !== false;
}

/** The extension in `dir/node_modules` as Oh My Pi loads one its lock names: a link (any folder where the plugins folder has no package.json) to a package it can read. */
function ompPluginLinked(dir: string, hasManifest: boolean): boolean {
  const entry = join(dir, "node_modules", ...EXTENSION.split("/"));
  try {
    if (hasManifest && !lstatSync(entry).isSymbolicLink()) return false;
    return statSync(join(entry, "package.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * Oh My Pi's default sessions folder for `cwd` (its `computeDefaultSessionDir`): under the temp root `-tmp-<relative>`,
 * under home `-<relative>`, anywhere else `--<absolute>--`, each separator a `-`.
 */
export function ompSessionDirOf(agentDir: string, cwd: string, home: string, temp: string = tmpdir()): string {
  return ompSessionDirIn(join(agentDir, "sessions"), cwd, home, temp);
}

/** The same folder under a sessions root (`ompSessionsRoot`). */
export function ompSessionDirIn(sessionsRoot: string, cwd: string, home: string, temp: string = tmpdir()): string {
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
  return join(resolve(sessionsRoot), name);
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
  // Under its sessions root, which XDG may move (`ompSessionsRoot`).
  sessionDirs: (_agentDir, cwd, home, env) => {
    const root = ompSessionsRoot(env, home);
    return [...new Set([env("TMPDIR"), tmpdir(), "/tmp"].filter((t): t is string => !!t).map((temp) => ompSessionDirIn(root, cwd, home, temp)))];
  },
  choices: false,
};

/** Oh My Pi's host: the Pi launcher with its flavor, its sessions as host `pi`, and no menus or Rex start (not yet). */
export function createOhMyPiLaunchHost(ctx: LaunchHostContext, options: Parameters<typeof createPiLaunchHost>[1] = {}): LaunchHost {
  const { choices: _choices, rexCommand: _rex, runsSession: _runs, sessionPids: _pids, ...host } = createPiLaunchHost(ctx, options, OMP_FLAVOR);
  return { ...host, sessionHost: "pi" };
}
