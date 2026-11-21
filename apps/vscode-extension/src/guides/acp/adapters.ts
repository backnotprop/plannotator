/**
 * ACP adapters Guided Reviews installs itself.
 *
 * Some agents speak ACP only through a separate npm adapter (Claude Code's
 * `claude-agent-acp`, `codex-acp`, `pi-acp`). When the adapter is neither set
 * in settings nor on PATH, Guided Reviews installs the exact version pinned in
 * the agent table into the extension's own storage, with
 * `npm install --ignore-scripts --before=<pin date>`: the pinned package and
 * every package it pulls in are ones published by that date, so the repo's
 * 7-day release-age rule holds for the whole tree. No global install, no
 * sudo, no `npx` at run time. Agents that are their own CLI (OpenCode,
 * Copilot, Cursor, Kiro, Kilo) are never installed here.
 *
 * Layout: `<globalStorage>/adapters/<agent id>/<copy>/` per installed copy,
 * and `<agent id>/current.json` naming the one to run. An install (or
 * "Update Agent Adapters") writes a new copy and then switches the pointer,
 * so a run still using the old copy (this window or another) is never
 * pulled out from under it; copies no longer current are removed once they
 * are a few hours old.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedAdapterSpec, ManagedLaunch } from "@plannotator/acp-client/agents";
import { findExecutable, type Runner } from "../sources/runner";

// The pinned adapter and its launch, as the agent table names them (packages/acp-client/agents.ts).
export type { ManagedAdapterSpec, ManagedLaunch };

const POINTER = "current.json";
/** Written into a copy when the pointer moves away from it: `{ replacedAt }`. */
const REPLACED_MARKER = ".plannotator-replaced.json";
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** A copy that is no longer current (or an install that never finished) is removed once older than this. */
const STALE_COPY_MS = 6 * 3600_000;

interface Pointer {
  package: string;
  version: string;
  /** The copy's folder name under the agent's folder. */
  copy: string;
}

export function adaptersRoot(globalStorage: string): string {
  return join(globalStorage, "adapters");
}

/** The agent's folder: its copies and `current.json`. */
export function managedDir(root: string, agentId: string): string {
  return join(root, agentId);
}

/** The command a person can run instead: a global install of the same pinned version. */
export function manualInstallCommand(spec: ManagedAdapterSpec): string {
  return `npm install -g ${spec.package}@${spec.version}`;
}

export interface LaunchDeps {
  findNode?: () => string | null;
  /** `node --version` of that program (cached per path), or null. */
  nodeVersion?: (node: string) => string | null;
  execPath?: string;
}

/**
 * The installed copy, when it is the pinned version and its entry file is
 * there; else null (not installed, an older pin, or a broken install). The
 * runtime is decided now, at each launch: `node` on PATH when its version
 * satisfies the package's `engines.node`, else VS Code's own runtime.
 */
export function managedLaunch(root: string, agentId: string, spec: ManagedAdapterSpec, agentArgs: readonly string[], deps: LaunchDeps = {}): ManagedLaunch | null {
  const agentDir = managedDir(root, agentId);
  const pointer = readJson<Pointer>(join(agentDir, POINTER));
  if (!pointer || pointer.package !== spec.package || pointer.version !== spec.version || !isCopyName(pointer.copy)) return null;
  const dir = join(agentDir, pointer.copy);
  const pkg = readPackage(dir, spec);
  const entry = pkg ? binEntry(dir, spec, pkg) : null;
  if (!pkg || !entry) return null;
  const node = (deps.findNode ?? (() => findExecutable("node")))();
  const version = node ? (deps.nodeVersion ?? cachedNodeVersion)(node) : null;
  if (node && version && satisfiesNodeRange(version, pkg.engines?.node)) return { command: node, args: [entry, ...agentArgs], dir };
  // VS Code's own runtime (Electron run as Node): no suitable Node on PATH needed.
  return { command: deps.execPath ?? process.execPath, args: [entry, ...agentArgs], env: { ELECTRON_RUN_AS_NODE: "1" }, dir };
}

interface PackageJson {
  version?: string;
  bin?: string | Record<string, string>;
  engines?: { node?: string };
}

function readPackage(dir: string, spec: ManagedAdapterSpec): PackageJson | null {
  const pkg = readJson<PackageJson>(join(dir, "node_modules", ...spec.package.split("/"), "package.json"));
  return pkg && pkg.version === spec.version ? pkg : null;
}

/** The JavaScript file a package's `bin` entry names, inside `<dir>/node_modules/<package>`. */
function binEntry(dir: string, spec: ManagedAdapterSpec, pkg: PackageJson): string | null {
  const pkgDir = join(dir, "node_modules", ...spec.package.split("/"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[spec.bin];
  if (!rel) return null;
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (parts.includes("..")) return null;
  const entry = join(pkgDir, ...parts);
  return existsSync(entry) ? entry : null;
}

export interface InstallDeps {
  runner: Runner;
  findExecutable?: (name: string) => string | null;
  platform?: NodeJS.Platform;
  /** For tests: the copy's folder name and the clock. */
  stamp?: string;
  now?: () => number;
}

export type InstallResult = { ok: true; dir: string } | { ok: false; message: string };

/**
 * `npm install --prefix <new copy> --ignore-scripts --before=<pin date> <package>@<version>`,
 * then `current.json` switches to the new copy (the old one stays for runs
 * still using it). One line of reason and the manual command on failure.
 */
export async function installAdapter(root: string, agentId: string, agentLabel: string, spec: ManagedAdapterSpec, deps: InstallDeps): Promise<InstallResult> {
  const find = deps.findExecutable ?? findExecutable;
  const now = deps.now ?? Date.now;
  const manual = manualInstallCommand(spec);
  const fail = (reason: string): InstallResult => ({ ok: false, message: `Could not install ${agentLabel}'s ACP adapter: ${reason}. Or run \`${manual}\` yourself.` });
  const npm = npmCommand(find, deps.platform ?? process.platform);
  if (!npm) return fail("npm is not on PATH (install Node.js from nodejs.org)");
  const agentDir = managedDir(root, agentId);
  sweepCopies(root, agentDir, now());
  // A name no other install (this window or another) can have, so a failed install never removes a copy in use.
  const copy = deps.stamp ?? `${spec.version}-${process.pid}-${now()}-${randomBytes(4).toString("hex")}`;
  const dir = join(agentDir, copy);
  try {
    mkdirSync(dir, { recursive: true });
    // A package.json of its own, so npm never walks up into some other project.
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `plannotator-adapter-${agentId}`, private: true }, null, 2)}\n`);
  } catch (err) {
    return fail(oneLine(err instanceof Error ? err.message : String(err)));
  }
  const args = [...npm.args, "install", "--prefix", dir, "--ignore-scripts", `--before=${spec.before}`, "--no-audit", "--no-fund", "--save-exact", "--loglevel=error", `${spec.package}@${spec.version}`];
  const result = await deps.runner(npm.command, args, { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return fail(result.code === 124 ? "npm timed out" : npmReason(result.stderr || result.stdout) || `npm exited with code ${result.code}`);
  }
  const pkg = readPackage(dir, spec);
  if (!pkg || !binEntry(dir, spec, pkg)) {
    rmSync(dir, { recursive: true, force: true });
    return fail(`npm finished but ${spec.bin} is missing`);
  }
  try {
    const previous = readJson<Pointer>(join(agentDir, POINTER))?.copy;
    const tmp = join(agentDir, `${POINTER}.${process.pid}-${now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify({ package: spec.package, version: spec.version, copy } satisfies Pointer, null, 2)}\n`);
    renameSync(tmp, join(agentDir, POINTER));
    // The copy that was current until now: when it stopped being current is what makes it old, not when it was installed.
    if (isCopyName(previous) && previous !== copy && existsSync(join(agentDir, previous))) {
      try {
        writeFileSync(join(agentDir, previous, REPLACED_MARKER), `${JSON.stringify({ replacedAt: now() })}\n`);
      } catch {
        // Without the marker the copy is judged by its folder's age, as an unfinished install is.
      }
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return fail(oneLine(err instanceof Error ? err.message : String(err)));
  }
  return { ok: true, dir };
}

/** Whether Guided Reviews installed a copy of this agent's adapter (any version), for "Update Agent Adapters". */
export function hasManagedCopy(root: string, agentId: string): boolean {
  return existsSync(join(managedDir(root, agentId), POINTER));
}

/**
 * Remove what no run can be using any more: copies that stopped being current
 * a few hours ago (judged by the time stamped into them when the pointer
 * moved away, so a long run in another window keeps its copy), installs that
 * never finished (by their folder's age), stray pointer temp files, and the
 * staging folders and files of the first layout (`<agent>.installing-*`, a
 * copy written straight into the agent's folder). The current copy is never
 * touched; when `current.json` is there but cannot be read (corrupt, or
 * caught mid-write), nothing is removed at all.
 */
export function sweepCopies(root: string, agentDir: string, now: number): void {
  const pointerPath = join(agentDir, POINTER);
  let current: string | undefined;
  if (existsSync(pointerPath)) {
    const pointer = readJson<Pointer>(pointerPath);
    if (!pointer || !isCopyName(pointer.copy)) return;
    current = pointer.copy;
  }
  const ageOf = (path: string): number | null => {
    const marker = readJson<{ replacedAt?: unknown }>(join(path, REPLACED_MARKER));
    if (marker && typeof marker.replacedAt === "number") return now - marker.replacedAt;
    try {
      return now - statSync(path).mtimeMs;
    } catch {
      return null;
    }
  };
  const old = (path: string) => {
    const age = ageOf(path);
    return age !== null && age > STALE_COPY_MS;
  };
  const remove = (path: string) => rmSync(path, { recursive: true, force: true });
  const agent = agentDir.slice(dirname(agentDir).length + 1);
  for (const name of safeList(root)) if (name.startsWith(`${agent}.installing-`) && old(join(root, name))) remove(join(root, name));
  for (const name of safeList(agentDir)) {
    if (name === POINTER || name === current) continue;
    const path = join(agentDir, name);
    if (old(path)) remove(path);
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isCopyName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

/**
 * npm itself. On Windows `npm.cmd` cannot be spawned without a shell, so run
 * the `npm-cli.js` beside it with Node (not tested on Windows itself).
 */
export function npmCommand(find: (name: string) => string | null, platform: NodeJS.Platform): { command: string; args: string[] } | null {
  const npm = find("npm");
  if (!npm) return null;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(npm)) return { command: npm, args: [] };
  const cli = join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  const node = find("node");
  return node && existsSync(cli) ? { command: node, args: [cli] } : null;
}

const nodeVersions = new Map<string, { mtime: number; version: string | null }>();

/** `node --version`, cached per program (and its file's mtime, so an upgraded node is asked again). */
function cachedNodeVersion(node: string): string | null {
  let mtime = 0;
  try {
    mtime = statSync(node).mtimeMs;
  } catch {
    return null;
  }
  const hit = nodeVersions.get(node);
  if (hit && hit.mtime === mtime) return hit.version;
  let version: string | null = null;
  try {
    version = execFileSync(node, ["--version"], { timeout: 5_000, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    version = null;
  }
  nodeVersions.set(node, { mtime, version });
  return version;
}

type Triple = [number, number, number];

/**
 * Whether a Node version (`v22.4.0`) satisfies an `engines.node` range: the
 * common npm forms (`>=22`, `>=18.17.0 <23`, `^20.9.0 || >=22`, `~20.1`,
 * `20.x`, `20`, `*`). A range it cannot read counts as not satisfied, so the
 * adapter runs on VS Code's own runtime instead. No range: satisfied.
 */
export function satisfiesNodeRange(version: string, range: string | undefined): boolean {
  if (range === undefined || range.trim() === "" || range.trim() === "*") return true;
  const v = parseVersion(version);
  if (!v) return false;
  return range.split("||").some((alt) => {
    const parts = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (parts.length === 0) return true;
    if (parts.length === 3 && parts[1] === "-") return cmp(v, lower(parts[0])) >= 0 && hyphenUpper(v, parts[2]);
    return parts.every((c) => comparator(v, c));
  });
}

function parseVersion(s: string): Triple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `20`, `20.1`, `20.x`, `20.1.x`, `20.1.3` → the parts given (null for x/*). */
function partial(s: string): [number | null, number | null, number | null] | null {
  const m = /^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(s);
  if (!m) return null;
  const n = (p: string | undefined) => (p === undefined || /^[x*]$/i.test(p) ? null : Number(p));
  return [n(m[1]), n(m[2]), n(m[3])];
}

function lower(s: string): Triple {
  const p = partial(s);
  return p ? [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] : [Infinity, 0, 0];
}

function cmp(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function hyphenUpper(v: Triple, s: string): boolean {
  const p = partial(s);
  if (!p) return false;
  if (p[0] === null) return true;
  if (p[1] === null) return v[0] <= p[0];
  if (p[2] === null) return cmp(v, [p[0], p[1], Infinity]) <= 0;
  return cmp(v, [p[0], p[1], p[2]]) <= 0;
}

function comparator(v: Triple, c: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(c);
  if (!m) return false;
  const op = m[1] ?? "";
  const p = partial(m[2]);
  if (!p) return false;
  if (p[0] === null) return true;
  const lo: Triple = [p[0], p[1] ?? 0, p[2] ?? 0];
  switch (op) {
    case ">=":
      return cmp(v, lo) >= 0;
    case ">":
      return p[1] === null ? v[0] > p[0] : p[2] === null ? cmp(v, [p[0], p[1], Infinity]) > 0 : cmp(v, lo) > 0;
    case "<":
      return cmp(v, lo) < 0;
    case "<=":
      return p[1] === null ? v[0] <= p[0] : p[2] === null ? cmp(v, [p[0], p[1], Infinity]) <= 0 : cmp(v, lo) <= 0;
    case "^": {
      const hi: Triple = lo[0] > 0 ? [lo[0] + 1, 0, 0] : lo[1] > 0 ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1];
      return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
    }
    case "~":
      return cmp(v, lo) >= 0 && cmp(v, p[1] === null ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0]) < 0;
    default:
      // `=`, or a bare (possibly partial) version: that version, or anything inside the part given.
      if (p[1] === null) return v[0] === p[0];
      if (p[2] === null) return v[0] === p[0] && v[1] === p[1];
      return cmp(v, lo) === 0;
  }
}

/** The line of npm's output that says what went wrong. */
export function npmReason(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/^npm (?:ERR!|error)\s*/i, "").trim()).filter((l) => l && !/^(?:A complete log|Log files|\d{4}-\d\d-\d\dT)/i.test(l));
  const code = lines.find((l) => /^code\s+\S+/i.test(l));
  const first = lines.find((l) => !/^code\s+/i.test(l)) ?? "";
  return oneLine([code?.replace(/^code\s+/i, ""), first].filter(Boolean).join(": ")).slice(0, 240);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
