/**
 * Isolated CallDiff execution over immutable review snapshots.
 *
 * CallDiff is a Node-native, synchronous Tree-sitter library. Plannotator runs
 * it in a short-lived Node worker (22.18 or newer) and never imports it into
 * Bun or Pi.
 */
import { childEnv } from "./child-env";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import runtimePackageJson from "./call-flow-runtime/package.json" with { type: "json" };
import runtimePackageLock from "./call-flow-runtime/package-lock.json" with { type: "json" };
import { CALL_FLOW_PACK_LOCKS } from "./call-flow-pack-locks";
import { withCallFlowInstallLock } from "./call-flow-install-lock";
import {
  CALL_FLOW_CORE_LANGUAGE_ID,
  CALL_FLOW_LANGUAGES,
  getCallFlowLanguage,
  getCallFlowLanguageForPath,
  getCallFlowPatchLanguageUsage,
} from "./call-flow-languages";
import type { CallFlowLanguageDefinition, CallFlowLanguageId } from "./call-flow-languages";
import { getPlannotatorDataDir } from "./data-dir";
import { gitColorFreeEnvironment } from "./review-core";
import { indexCallFlowImpacts, parseCallDiffWorkerResult } from "./call-flow-types";
import type {
  CallFlowAdvert,
  CallFlowInstallStage,
  CallFlowResponse,
  ParsedCallDiffWorkerResult,
} from "./call-flow-types";

export const CALLDIFF_VERSION = "0.6.0";
export const CALLDIFF_COMMIT = "2086f6e4e9ed3c410bba7c94ca3dde77791b1956";
export const CALLDIFF_SOURCE_SPEC = `https://github.com/tanishqkancharla/calldiff/archive/${CALLDIFF_COMMIT}.tar.gz`;
export const CALLDIFF_SOURCE_INTEGRITY = "sha512-t+YCPz0WkETiwSOznwx3mLxVkEUe7DVACV+it2HJER7q/ha+K0IavN9IfBvP+7/ijzPXoUHgJIkAM/kg1O5S6A==";
export const CALLDIFF_TREE_SITTER_VERSION = "0.25.1";
/** CallDiff's own `engines.node` floor at the pinned commit (>=22.18.0). */
export const CALL_FLOW_MIN_NODE_VERSION = { major: 22, minor: 18 } as const;
const CALL_FLOW_NODE_REQUIREMENT = "Node.js 22.18 or newer";
const CALLDIFF_ARCHIVE_FILE = `calldiff-${CALLDIFF_COMMIT}.tar.gz`;
const MAX_CALLDIFF_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_PACK_ARCHIVES_BYTES = 256 * 1024 * 1024;

const CORE_GRAMMAR_PACKAGES = ["tree-sitter-javascript", "tree-sitter-typescript"] as const;
const CORE_RUNTIME_DEPENDENCIES = [
  { packageName: "tree-sitter", version: CALLDIFF_TREE_SITTER_VERSION, label: "Tree-sitter" },
  { packageName: "tree-sitter-javascript", version: "0.25.0", label: "JavaScript" },
  { packageName: "tree-sitter-typescript", version: "0.23.2", label: "TypeScript" },
] as const;
const CORE_PRUNED_PACKAGES = [
  "@types",
  "typescript",
  "undici-types",
  "node-addon-api",
  "incur",
  "@cfworker",
  "@modelcontextprotocol",
  "@scalar",
  "@toon-format",
  "tokenx",
  "yaml",
  "zod",
] as const;

const WORKER_TIMEOUT_MS = 45_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_PROCESS_OUTPUT_BYTES = 12 * 1024 * 1024;

export interface CallFlowAnalysisInput {
  snapshotId: string;
  rawPatch: string;
  snapshot: CallFlowSnapshotSource;
  /** Revalidate mutable review state before an ok result can enter the cache. */
  verifySnapshot?: () => Promise<boolean>;
}

export interface CallFlowSnapshotSource {
  materialize(options: {
    includedExtensions: readonly string[];
    signal?: AbortSignal;
  }): Promise<SnapshotPlan>;
}

export type CallFlowRuntime = {
  nodePath: string;
  packageEntry: string;
  runtimeDir: string;
  grammarCacheDir: string;
  installedLanguageIds: CallFlowLanguageId[];
  managed: boolean;
  version: string;
};

export type CallFlowRuntimeResolution =
  | { ok: true; runtime: CallFlowRuntime }
  | { ok: false; reason: string; message: string };

export type CallFlowRuntimeInstallResult =
  | { ok: true; status: "installed" | "already-installed"; runtimeDir: string; languageId: CallFlowLanguageId; message: string; sizeBeforePruneBytes?: number; sizeAfterPruneBytes?: number }
  | { ok: false; status: "failed"; runtimeDir: string; message: string };

export type { CallFlowInstallStage };

export type CallFlowNodePreflight =
  | { ok: true }
  | { ok: false; reason: "node-unavailable" | "node-version"; message: string };

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted: boolean;
}

export interface SnapshotPlan {
  cwd: string;
  from: string;
  to: string;
  cleanup: () => void;
}

class CallFlowMissingGrammarError extends Error {
  readonly reason = "missing-grammar";
}

const WORKER_SOURCE = String.raw`
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const diagnostics = [];
const originalError = console.error;
console.error = (...values) => {
  diagnostics.push({ level: "warning", message: values.map(String).join(" ") });
};
try {
  for (const grammar of request.grammars) {
    const packageJson = grammar.packageJson;
    if (!existsSync(packageJson)) {
      process.stdout.write(JSON.stringify({ protocol: 1, ok: false, reason: "missing-grammar", message: grammar.message, diagnostics }));
      process.exit(2);
    }
    const installed = JSON.parse(readFileSync(packageJson, "utf8"));
    if (installed.version !== grammar.version) {
      process.stdout.write(JSON.stringify({ protocol: 1, ok: false, reason: "missing-grammar", message: grammar.message, diagnostics }));
      process.exit(2);
    }
  }
  const moduleUrl = pathToFileURL(request.packageEntry).href;
  const mod = await import(moduleUrl);
  if (typeof mod.runDiff !== "function") throw new Error("CallDiff does not export runDiff().");
  const result = mod.runDiff({
    cwd: request.cwd,
    from: request.from,
    to: request.to,
    maxDepth: request.maxDepth,
    color: false,
    locs: true,
    paths: request.paths,
  });
  process.stdout.write(JSON.stringify({ protocol: 1, ok: true, version: request.version, result, diagnostics }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ protocol: 1, ok: false, message, diagnostics }));
  process.exitCode = 1;
} finally {
  console.error = originalError;
}
`;

export function getCallFlowManagedRuntimeDir(dataDir = getPlannotatorDataDir()): string {
  return join(dataDir, "vendor", "call-flow", `calldiff-${CALLDIFF_VERSION}`);
}

function getCallFlowGrammarCacheDir(runtimeDir: string): string {
  return join(runtimeDir, "grammar-cache");
}

function getLanguagePackageRoot(runtimeDir: string, language: CallFlowLanguageDefinition): string {
  if (language.kind === "core") return join(runtimeDir, "node_modules", "tree-sitter-typescript");
  return join(getCallFlowGrammarCacheDir(runtimeDir), "node_modules", ...(language.packageName ?? "").split("/"));
}

function getLanguageLockMarker(runtimeDir: string, id: CallFlowLanguageId): string {
  return join(getCallFlowGrammarCacheDir(runtimeDir), ".plannotator-locks", `${id}.json`);
}

function packHasCommittedLock(runtimeDir: string, id: Exclude<CallFlowLanguageId, "javascript-typescript">): boolean {
  try {
    const installed: unknown = JSON.parse(readFileSync(getLanguageLockMarker(runtimeDir, id), "utf8"));
    return JSON.stringify(installed) === JSON.stringify(CALL_FLOW_PACK_LOCKS[id]);
  } catch {
    return false;
  }
}

function installDirHasCommittedPackLock(installDir: string, id: Exclude<CallFlowLanguageId, "javascript-typescript">): boolean {
  try {
    const installed: unknown = JSON.parse(readFileSync(join(installDir, "package-lock.json"), "utf8"));
    return JSON.stringify(installed) === JSON.stringify(CALL_FLOW_PACK_LOCKS[id]);
  } catch {
    return false;
  }
}

function isLanguageInstalled(runtimeDir: string, language: CallFlowLanguageDefinition, managed: boolean): boolean {
  if (language.kind === "core") return true;
  const packageRoot = managed
    ? getLanguagePackageRoot(runtimeDir, language)
    : join(runtimeDir, "node_modules", ...(language.packageName ?? "").split("/"));
  if (readPackageVersion(packageRoot) !== language.packageVersion) return false;
  return !managed || packHasCommittedLock(runtimeDir, language.id as Exclude<CallFlowLanguageId, "javascript-typescript">);
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function resolvePackageEntry(packageRoot: string): string | null {
  // Import the analysis module directly. dist/index.js eagerly exports the
  // CLI, which pulls an otherwise-unused schema/MCP dependency tree into the
  // managed runtime.
  const entry = join(packageRoot, "dist", "run.js");
  return existsSync(entry) ? entry : null;
}

function runtimeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hasCommittedRuntimeLock(runtimeDir: string): boolean {
  try {
    const lock: unknown = JSON.parse(readFileSync(join(runtimeDir, "package-lock.json"), "utf8"));
    return JSON.stringify(lock) === JSON.stringify(runtimePackageLock);
  } catch {
    return false;
  }
}

/** True when a `node --version` string meets CallDiff's 22.18 floor. */
export function callFlowNodeVersionSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const floor = CALL_FLOW_MIN_NODE_VERSION;
  return major > floor.major || (major === floor.major && minor >= floor.minor);
}

async function checkCallFlowNode(nodePath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await runCommand(nodePath, ["--version"], { timeoutMs: 3_000 });
  const found = result.stdout.trim();
  if (result.exitCode !== 0 || !/^v\d+\.\d+/.test(found)) return { ok: false, message: "Node.js could not be started." };
  if (!callFlowNodeVersionSupported(found)) {
    return { ok: false, message: `Call flow needs ${CALL_FLOW_NODE_REQUIREMENT}. You have Node.js ${found}.` };
  }
  return { ok: true };
}

function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH;
  if (!pathValue) return null;
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Cheap Node availability check used before any runtime download starts.
 * The in-app install endpoint runs this preflight synchronously so a
 * missing or too-old Node reports immediately, without background work.
 */
export async function preflightCallFlowNode(): Promise<CallFlowNodePreflight> {
  const nodePath = findExecutable("node");
  if (!nodePath) return { ok: false, reason: "node-unavailable", message: `Call flow needs ${CALL_FLOW_NODE_REQUIREMENT}, which was not found on PATH.` };
  const nodeCheck = await checkCallFlowNode(nodePath);
  if (!nodeCheck.ok) return { ok: false, reason: "node-version", message: nodeCheck.message };
  return { ok: true };
}

/** Resolve the pruned core and report independently installed language packs. */
export async function resolveCallFlowRuntime(): Promise<CallFlowRuntimeResolution> {
  const nodePath = findExecutable("node");
  if (!nodePath) return { ok: false, reason: "node-unavailable", message: `Call flow needs ${CALL_FLOW_NODE_REQUIREMENT}, which was not found on PATH.` };
  const nodeCheck = await checkCallFlowNode(nodePath);
  if (!nodeCheck.ok) return { ok: false, reason: "node-version", message: nodeCheck.message };

  const override = process.env.PLANNOTATOR_CALLDIFF_PATH?.trim();
  if (override && !isAbsolute(override)) {
    return {
      ok: false,
      reason: "override-relative",
      message: "PLANNOTATOR_CALLDIFF_PATH must be an absolute path.",
    };
  }
  const runtimeDir = override ?? getCallFlowManagedRuntimeDir();
  const managed = !override;
  const packageRoot = override ? runtimeDir : join(runtimeDir, "node_modules", "calldiff");
  const version = readPackageVersion(packageRoot);
  const packageEntry = resolvePackageEntry(packageRoot);
  if (!version || !packageEntry) {
    return {
      ok: false,
      reason: "runtime-unavailable",
      message: override
        ? `PLANNOTATOR_CALLDIFF_PATH does not contain a built CallDiff package: ${runtimeDir}`
        : "The Call flow core is not installed.",
    };
  }
  if (version !== CALLDIFF_VERSION) {
    return { ok: false, reason: "version-mismatch", message: `CallDiff ${version} is installed; Plannotator requires ${CALLDIFF_VERSION}.` };
  }
  if (!override) {
    const revisionPath = join(runtimeDir, ".calldiff-revision");
    const installedRevision = existsSync(revisionPath) ? readFileSync(revisionPath, "utf8").trim() : "";
    if (installedRevision !== CALLDIFF_COMMIT) {
      return { ok: false, reason: "revision-mismatch", message: "The managed Call flow core is stale and needs reinstalling." };
    }
    if (!hasCommittedRuntimeLock(runtimeDir)) {
      return { ok: false, reason: "runtime-lock-mismatch", message: "The managed Call flow core dependency lock is stale and needs reinstalling." };
    }
  }
  const invalidCore = CORE_RUNTIME_DEPENDENCIES.filter(({ packageName, version: expected }) => (
    readPackageVersion(join(runtimeDir, "node_modules", packageName)) !== expected
  ));
  if (invalidCore.length > 0) {
    return {
      ok: false,
      reason: "core-incomplete",
      message: `The Call flow core has missing or stale dependencies (${invalidCore.map(({ label }) => label).join(", ")}). Reinstall its managed runtime.`,
    };
  }
  const installedLanguageIds = CALL_FLOW_LANGUAGES
    .filter((language) => isLanguageInstalled(runtimeDir, language, managed))
    .map((language) => language.id);
  return {
    ok: true,
    runtime: {
      nodePath,
      packageEntry,
      runtimeDir,
      grammarCacheDir: managed ? getCallFlowGrammarCacheDir(runtimeDir) : runtimeDir,
      installedLanguageIds,
      managed,
      version,
    },
  };
}

function writeRuntimeManifest(runtimeDir: string): void {
  writeFileSync(join(runtimeDir, "package.json"), runtimeJson(runtimePackageJson), "utf8");
  writeFileSync(join(runtimeDir, "package-lock.json"), runtimeJson(runtimePackageLock), "utf8");
}

function removeDirectoryBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Antivirus and native grammar handles can briefly keep Windows directories
    // busy. Cleanup must never replace the caller-visible analysis/install result.
  }
}

async function downloadVerifiedCallDiffArchive(
  destination: string,
  onStage: (stage: CallFlowInstallStage) => void,
): Promise<void> {
  onStage("downloading");
  const response = await fetch(CALLDIFF_SOURCE_SPEC, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`CallDiff download failed with HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  const hash = createHash("sha512");
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > MAX_CALLDIFF_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error("CallDiff source archive exceeded the 20 MB install limit.");
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  onStage("verifying");
  const integrity = `sha512-${hash.digest("base64")}`;
  if (integrity !== CALLDIFF_SOURCE_INTEGRITY) {
    throw new Error("CallDiff source archive failed its repository-pinned SHA-512 check.");
  }
  // No archive bytes are written, unpacked, or passed to npm until the digest
  // above matches the repository-owned pin.
  writeFileSync(destination, Buffer.concat(chunks, totalBytes));
}

type VerifiedLockArtifact = { url: string; integrity: string; bytes: Buffer };

async function downloadVerifiedLockArtifacts(
  lock: unknown,
  destination: string,
  onStage: (stage: CallFlowInstallStage) => void,
): Promise<string[]> {
  const packages = (lock as { packages?: Record<string, { resolved?: unknown; integrity?: unknown }> }).packages;
  if (!packages) throw new Error("The committed grammar lock has no package records.");
  const specs = new Map<string, { url: string; integrity: string }>();
  for (const entry of Object.values(packages)) {
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://")) continue;
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      throw new Error(`The committed grammar lock has no SHA-512 integrity for ${entry.resolved}.`);
    }
    specs.set(`${entry.resolved}\0${entry.integrity}`, { url: entry.resolved, integrity: entry.integrity });
  }
  if (specs.size === 0) throw new Error("The committed grammar lock has no downloadable package artifacts.");

  onStage("downloading");
  const downloaded: VerifiedLockArtifact[] = [];
  let totalBytes = 0;
  for (const spec of specs.values()) {
    const response = await fetch(spec.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) {
      throw new Error(`Pinned grammar download failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let artifactBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      artifactBytes += chunk.length;
      totalBytes += chunk.length;
      if (totalBytes > MAX_PACK_ARCHIVES_BYTES) {
        await reader.cancel();
        throw new Error("Pinned grammar downloads exceeded the 256 MB install limit.");
      }
      chunks.push(chunk);
    }
    downloaded.push({ ...spec, bytes: Buffer.concat(chunks, artifactBytes) });
  }

  onStage("verifying");
  mkdirSync(destination, { recursive: true });
  const verifiedPaths: string[] = [];
  for (const [index, artifact] of downloaded.entries()) {
    const integrity = `sha512-${createHash("sha512").update(artifact.bytes).digest("base64")}`;
    if (integrity !== artifact.integrity) {
      throw new Error(`Pinned grammar package failed its repository-owned SHA-512 check: ${artifact.url}`);
    }
    const path = join(destination, `artifact-${index}.tgz`);
    // Only verified bytes become visible to npm.
    writeFileSync(path, artifact.bytes);
    verifiedPaths.push(path);
  }
  return verifiedPaths;
}

async function seedVerifiedNpmCache(
  npmPath: string,
  installDir: string,
  artifacts: readonly string[],
): Promise<string> {
  const cacheDir = join(installDir, ".verified-npm-cache");
  for (const artifact of artifacts) {
    const cached = await runCommand(npmPath, [
      "cache", "add", artifact, "--cache", cacheDir, "--ignore-scripts",
    ], {
      cwd: installDir,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
      env: {
        ...process.env,
        npm_config_offline: "true",
        NPM_CONFIG_OFFLINE: "true",
        npm_config_ignore_scripts: "true",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
    });
    if (cached.exitCode !== 0) {
      throw new Error(cached.stderr.trim() || cached.stdout.trim() || "Could not stage a verified grammar package.");
    }
  }
  return cacheDir;
}

const PRUNED_PACKAGE_DIRECTORIES = [
  "build",
  "src",
  "vendor",
  "queries",
  "common",
  "grammars",
  "typescript",
  "tsx",
] as const;

function removeDirectoryStrict(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function assertPathRemoved(path: string, description: string): void {
  if (existsSync(path)) throw new Error(`Call-flow pruning did not remove ${description}.`);
}

function prunePrebuilds(packageRoot: string): void {
  const prebuilds = join(packageRoot, "prebuilds");
  if (!existsSync(prebuilds)) return;
  const currentPlatform = `${process.platform}-${process.arch}`;
  for (const entry of readdirSync(prebuilds)) {
    if (entry !== currentPlatform) removeDirectoryStrict(join(prebuilds, entry));
  }
}

function assertNativePackagePruned(packageRoot: string): void {
  for (const directory of PRUNED_PACKAGE_DIRECTORIES) {
    if (directory !== "build") {
      assertPathRemoved(join(packageRoot, directory), `${basename(packageRoot)}/${directory}`);
    }
  }
  assertPathRemoved(join(packageRoot, "node_modules"), `${basename(packageRoot)}/node_modules`);
  for (const file of ["binding.gyp", "grammar.js", "tree-sitter.json"]) {
    assertPathRemoved(join(packageRoot, file), `${basename(packageRoot)}/${file}`);
  }
  const prebuilds = join(packageRoot, "prebuilds");
  if (existsSync(prebuilds)) {
    const currentPlatform = `${process.platform}-${process.arch}`;
    const foreign = readdirSync(prebuilds).filter((entry) => entry !== currentPlatform);
    if (foreign.length > 0) {
      throw new Error(`Call-flow pruning retained foreign ${basename(packageRoot)} prebuilds: ${foreign.join(", ")}.`);
    }
  }
  const assertOnlyNativeAddons = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) assertOnlyNativeAddons(path);
      else if (!entry.isFile() || !entry.name.endsWith(".node")) {
        throw new Error(`Call-flow pruning retained a non-runtime build artifact in ${basename(packageRoot)}: ${entry.name}.`);
      }
    }
  };
  assertOnlyNativeAddons(join(packageRoot, "build"));
  const bindings = join(packageRoot, "bindings", "node");
  if (existsSync(bindings)) {
    const retainedSource = readdirSync(bindings).find((file) => file === "binding.cc" || file.endsWith("_test.js"));
    if (retainedSource) throw new Error(`Call-flow pruning retained ${basename(packageRoot)}/${retainedSource}.`);
  }
  if (existsSync(packageRoot)) {
    const wasm = readdirSync(packageRoot).find((file) => file.endsWith(".wasm"));
    if (wasm) throw new Error(`Call-flow pruning retained ${basename(packageRoot)}/${wasm}.`);
  }
}

/** Keep only the loadable native payload for one npm Tree-sitter package. */
export function pruneCallFlowNativePackage(packageRoot: string): void {
  const builtAddons: Array<{ name: string; bytes: Buffer }> = [];
  const collectBuiltAddons = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collectBuiltAddons(path);
      else if (entry.isFile() && entry.name.endsWith(".node")) {
        builtAddons.push({ name: basename(path), bytes: readFileSync(path) });
      }
    }
  };
  collectBuiltAddons(join(packageRoot, "build"));
  prunePrebuilds(packageRoot);
  for (const directory of PRUNED_PACKAGE_DIRECTORIES) {
    removeDirectoryStrict(join(packageRoot, directory));
  }
  removeDirectoryStrict(join(packageRoot, "node_modules"));
  const bindings = join(packageRoot, "bindings", "node");
  if (existsSync(bindings)) {
    for (const file of readdirSync(bindings)) {
      if (file === "binding.cc" || file.endsWith("_test.js")) rmSync(join(bindings, file), { force: true });
    }
  }
  for (const file of ["binding.gyp", "grammar.js", "tree-sitter.json"]) {
    rmSync(join(packageRoot, file), { force: true });
  }
  if (builtAddons.length > 0) {
    const releaseDir = join(packageRoot, "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    for (const addon of builtAddons) writeFileSync(join(releaseDir, addon.name), addon.bytes);
  }
  if (existsSync(packageRoot)) {
    for (const file of readdirSync(packageRoot)) {
      if (file.endsWith(".wasm")) rmSync(join(packageRoot, file), { force: true });
    }
  }
  assertNativePackagePruned(packageRoot);
}

function pruneCoreRuntime(runtimeDir: string): void {
  for (const packageName of ["tree-sitter", ...CORE_GRAMMAR_PACKAGES]) {
    pruneCallFlowNativePackage(join(runtimeDir, "node_modules", packageName));
  }
  const packageRoot = join(runtimeDir, "node_modules", "calldiff");
  removeDirectoryStrict(join(packageRoot, "src"));
  for (const file of readdirSync(join(packageRoot, "dist"))) {
    if (file.startsWith("cli.") || file === "index.js" || file === "index.d.ts") {
      rmSync(join(packageRoot, "dist", file), { force: true });
    }
  }
  for (const packagePath of CORE_PRUNED_PACKAGES) {
    removeDirectoryStrict(join(runtimeDir, "node_modules", ...packagePath.split("/")));
  }
  removeDirectoryStrict(join(runtimeDir, "node_modules", ".bin"));
  assertPathRemoved(join(packageRoot, "src"), "calldiff/src");
  for (const packagePath of CORE_PRUNED_PACKAGES) {
    assertPathRemoved(join(runtimeDir, "node_modules", ...packagePath.split("/")), `node_modules/${packagePath}`);
  }
  assertPathRemoved(join(runtimeDir, "node_modules", ".bin"), "node_modules/.bin");
}

function validationFilesForLanguage(id: CallFlowLanguageId): string[] {
  if (id === CALL_FLOW_CORE_LANGUAGE_ID) {
    // Exercise both independently pinned core grammar packages after pruning.
    return ["validation.js", "validation.ts"];
  }
  const extension = getCallFlowLanguage(id).extensions[0];
  return [`validation${extension}`];
}

async function validatePrunedLanguage(
  nodePath: string,
  runtimeDir: string,
  grammarCacheDir: string,
  ids: readonly CallFlowLanguageId[],
): Promise<void> {
  const extractEntry = join(runtimeDir, "node_modules", "calldiff", "dist", "extract.js");
  const script = String.raw`
import { pathToFileURL } from "node:url";
const request = JSON.parse(process.argv[1]);
const mod = await import(pathToFileURL(request.extractEntry).href);
for (const file of request.files) mod.extractFunctions(file, "");
`;
  const npmBlocker = await createNpmBlocker();
  try {
    const result = await runCommand(nodePath, ["--input-type=module", "--eval", script, JSON.stringify({
      extractEntry,
      files: ids.flatMap(validationFilesForLanguage),
    })], {
      cwd: runtimeDir,
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
      env: {
        ...process.env,
        // CallDiff runs git itself; keep a user's `color.diff = always` from
        // wrapping its diff in ANSI escapes (#1661).
        ...gitColorFreeEnvironment(process.env),
        PATH: `${npmBlocker.path}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        CALLDIFF_GRAMMAR_CACHE: grammarCacheDir,
        npm_config_offline: "true",
        NPM_CONFIG_OFFLINE: "true",
        npm_config_ignore_scripts: "true",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "The pruned grammar failed runtime validation.");
    }
  } finally {
    npmBlocker.cleanup();
  }
}

function ensureGrammarCacheManifest(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "package.json"), runtimeJson({
    name: "plannotator-calldiff-grammar-cache",
    private: true,
  }), "utf8");
}

/**
 * Copy optional packs into a candidate core. Sources are tried in order (the
 * current runtime first, then folders left by older pins); a pack crosses only
 * when its exact committed lock marker matches and it loads through the
 * candidate core. Packs are pinned independently of CallDiff, so an upgrade
 * keeps the user's installed languages instead of downloading them again.
 */
export async function preserveValidatedLanguagePacks(
  nodePath: string,
  sourceRuntimeDirs: readonly string[],
  candidateRuntimeDir: string,
): Promise<CallFlowLanguageId[]> {
  const candidateCache = getCallFlowGrammarCacheDir(candidateRuntimeDir);
  ensureGrammarCacheManifest(candidateCache);
  const preserved: CallFlowLanguageId[] = [];
  for (const language of CALL_FLOW_LANGUAGES) {
    if (language.kind !== "pack") continue;
    const packId = language.id as Exclude<CallFlowLanguageId, "javascript-typescript">;
    const candidateRoot = getLanguagePackageRoot(candidateRuntimeDir, language);
    for (const sourceRuntimeDir of sourceRuntimeDirs) {
      if (!isLanguageInstalled(sourceRuntimeDir, language, true)) continue;
      mkdirSync(dirname(candidateRoot), { recursive: true });
      cpSync(getLanguagePackageRoot(sourceRuntimeDir, language), candidateRoot, { recursive: true, force: true });
      try {
        await validatePrunedLanguage(nodePath, candidateRuntimeDir, candidateCache, [language.id]);
        const marker = getLanguageLockMarker(candidateRuntimeDir, language.id);
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, runtimeJson(CALL_FLOW_PACK_LOCKS[packId]), "utf8");
        preserved.push(language.id);
        break;
      } catch {
        // A pack whose files no longer load is not independently verified and
        // must not cross the atomic core repair boundary.
        removeDirectoryStrict(candidateRoot);
      }
    }
  }
  return preserved;
}

/**
 * Folder names Plannotator itself creates for a managed core: the published
 * `calldiff-<version>` and the `.previous-<pid>-<ms>` backup a core swap
 * leaves when it is interrupted. Nothing else in vendor/call-flow matches.
 */
const MANAGED_CORE_DIR_PATTERN = /^calldiff-(\d+)\.(\d+)\.(\d+)(\.previous-\d+-\d+)?$/;

function compareVersionTriples(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * Managed core folders under this data dir that no current or newer
 * Plannotator uses: cores of an older CallDiff pin, and interrupted-swap
 * backups of an older or the current pin. A newer pin's folder and backups
 * are kept, so downgrading and upgrading again finds it still installed.
 */
export function listStaleCallFlowRuntimeDirs(dataDir = getPlannotatorDataDir()): string[] {
  const currentDir = getCallFlowManagedRuntimeDir(dataDir);
  const parent = dirname(currentDir);
  const current = CALLDIFF_VERSION.split(".").map(Number);
  let entries: Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const entry of entries) {
    // Dirent types come from lstat: a symlink is never followed or removed.
    if (!entry.isDirectory()) continue;
    const match = MANAGED_CORE_DIR_PATTERN.exec(entry.name);
    if (!match) continue;
    const isBackup = match[4] !== undefined;
    const version = [Number(match[1]), Number(match[2]), Number(match[3])];
    const order = compareVersionTriples(version, current);
    if (order < 0 || (isBackup && order === 0)) stale.push(join(parent, entry.name));
  }
  return stale.sort();
}

/**
 * A stale core is renamed to this dot-prefixed name before it is deleted. No
 * Plannotator version resolves a dot-prefixed folder, so a delete cut short
 * (a killed process, a busy file on Windows) never leaves a half-deleted
 * `calldiff-<x.y.z>` that an older Plannotator would take as installed.
 */
const STALE_TOMBSTONE_PATTERN = /^\.calldiff-stale-\d+-\d+-\d+$/;

/**
 * Remove stale managed cores once the current pin is published. Runs only
 * under the install lease and only after a successful install, so a failed
 * upgrade keeps the previous folder for a downgrade. Each folder is first
 * renamed to a tombstone (atomic); one that cannot be renamed (in use on
 * Windows) stays whole and is retried by the next install. Tombstones,
 * including any an earlier interrupted delete left, are then removed.
 */
export function removeStaleCallFlowRuntimeDirs(dataDir = getPlannotatorDataDir()): void {
  const parent = dirname(getCallFlowManagedRuntimeDir(dataDir));
  const stamp = `${process.pid}-${Date.now()}`;
  listStaleCallFlowRuntimeDirs(dataDir).forEach((path, index) => {
    try {
      renameSync(path, join(parent, `.calldiff-stale-${stamp}-${index}`));
    } catch {
      // Left whole under its own name; the next install tries again.
    }
  });
  let entries: Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && STALE_TOMBSTONE_PATTERN.test(entry.name)) {
      removeDirectoryBestEffort(join(parent, entry.name));
    }
  }
}

/** Recursively measure installed bytes for size regression tests and release evidence. */
export function measureCallFlowDirectoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + measureCallFlowDirectoryBytes(join(path, entry)), 0);
}

export async function installCallFlowRuntime(
  onStage: (stage: CallFlowInstallStage) => void = () => {},
): Promise<CallFlowRuntimeInstallResult> {
  return await withCallFlowInstallLock(() => installCallFlowRuntimeUnlocked(onStage));
}

async function installCallFlowRuntimeUnlocked(
  onStage: (stage: CallFlowInstallStage) => void,
): Promise<CallFlowRuntimeInstallResult> {
  const runtimeDir = getCallFlowManagedRuntimeDir();
  const nodePath = findExecutable("node");
  const npmPath = findExecutable("npm");
  if (!nodePath || !npmPath) {
    return { ok: false, status: "failed", runtimeDir, message: `Call flow needs ${CALL_FLOW_NODE_REQUIREMENT} and npm on PATH.` };
  }
  const nodeCheck = await checkCallFlowNode(nodePath);
  if (!nodeCheck.ok) return { ok: false, status: "failed", runtimeDir, message: nodeCheck.message };

  const existing = await resolveCallFlowRuntime();
  if (existing.ok && existing.runtime.runtimeDir === runtimeDir) {
    removeStaleCallFlowRuntimeDirs();
    return { ok: true, status: "already-installed", runtimeDir, languageId: CALL_FLOW_CORE_LANGUAGE_ID, message: `Call-flow core already installed at ${runtimeDir}.` };
  }
  const runtimeParent = dirname(runtimeDir);
  mkdirSync(runtimeParent, { recursive: true });
  const installDir = await mkdtemp(join(runtimeParent, ".calldiff-install-"));
  const backupDir = `${runtimeDir}.previous-${process.pid}-${Date.now()}`;
  try {
    writeRuntimeManifest(installDir);
    await downloadVerifiedCallDiffArchive(join(installDir, CALLDIFF_ARCHIVE_FILE), onStage);

    onStage("installing-deps");
    const install = await runCommand(npmPath, [
      "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--legacy-peer-deps",
    ], { cwd: installDir, timeoutMs: 240_000, maxOutputBytes: 4 * 1024 * 1024 });
    if (install.exitCode !== 0) {
      throw new Error(install.stderr.trim() || install.stdout.trim() || "npm ci failed");
    }

    // npm ci intentionally ran with every lifecycle script disabled. Only the
    // integrity-locked parser packages are rebuilt, as one explicit step.
    const rebuild = await runCommand(npmPath, [
      "rebuild", "--no-audit", "--no-fund", "--legacy-peer-deps",
      "tree-sitter", ...CORE_GRAMMAR_PACKAGES,
    ], {
      cwd: installDir,
      timeoutMs: 240_000,
      maxOutputBytes: 4 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_ignore_scripts: "false",
        NPM_CONFIG_IGNORE_SCRIPTS: "false",
      },
    });
    if (rebuild.exitCode !== 0) {
      throw new Error(rebuild.stderr.trim() || rebuild.stdout.trim() || "grammar rebuild failed");
    }

    onStage("building");
    const packageRoot = join(installDir, "node_modules", "calldiff");
    const tscPath = process.platform === "win32"
      ? join(installDir, "node_modules", ".bin", "tsc.cmd")
      : join(installDir, "node_modules", ".bin", "tsc");
    const build = await runCommand(tscPath, ["-p", "tsconfig.json"], {
      cwd: packageRoot,
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (build.exitCode !== 0) {
      throw new Error(build.stderr.trim() || build.stdout.trim() || "CallDiff TypeScript build failed");
    }
    rmSync(join(installDir, CALLDIFF_ARCHIVE_FILE), { force: true });
    writeFileSync(join(installDir, ".calldiff-revision"), `${CALLDIFF_COMMIT}\n`, "utf8");
    if (readPackageVersion(packageRoot) !== CALLDIFF_VERSION || !resolvePackageEntry(packageRoot)) {
      throw new Error("The verified CallDiff package did not produce the expected runtime entry.");
    }
    if (!hasCommittedRuntimeLock(installDir)) throw new Error("npm changed the committed call-flow dependency lock.");
    const sizeBeforePruneBytes = measureCallFlowDirectoryBytes(installDir);
    pruneCoreRuntime(installDir);
    ensureGrammarCacheManifest(getCallFlowGrammarCacheDir(installDir));
    await validatePrunedLanguage(nodePath, installDir, getCallFlowGrammarCacheDir(installDir), [CALL_FLOW_CORE_LANGUAGE_ID]);
    const sizeAfterPruneBytes = measureCallFlowDirectoryBytes(installDir);

    // A core repair or upgrade preserves only packs whose exact marker,
    // package version, and native payload all still validate against the
    // candidate core. An upgrade takes them from the older pin's folder.
    const nextCache = getCallFlowGrammarCacheDir(installDir);
    await preserveValidatedLanguagePacks(nodePath, [runtimeDir, ...listStaleCallFlowRuntimeDirs()], installDir);
    ensureGrammarCacheManifest(nextCache);

    if (existsSync(runtimeDir)) renameSync(runtimeDir, backupDir);
    try {
      renameSync(installDir, runtimeDir);
    } catch (error) {
      if (existsSync(backupDir)) renameSync(backupDir, runtimeDir);
      throw error;
    }
    removeDirectoryBestEffort(backupDir);
    // Only now that the new pin is published do older pins' folders go.
    removeStaleCallFlowRuntimeDirs();
    return { ok: true, status: "installed", runtimeDir, languageId: CALL_FLOW_CORE_LANGUAGE_ID, sizeBeforePruneBytes, sizeAfterPruneBytes, message: `Installed the pruned CallDiff ${CALLDIFF_VERSION} core at ${runtimeDir}.` };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      runtimeDir,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    };
  } finally {
    removeDirectoryBestEffort(installDir);
  }
}

function packManifest(id: Exclude<CallFlowLanguageId, "javascript-typescript">): Record<string, unknown> {
  const root = CALL_FLOW_PACK_LOCKS[id].packages[""];
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error(`The committed ${id} grammar lock has no root package.`);
  }
  const record = root as Record<string, unknown>;
  return {
    name: record.name,
    version: record.version,
    private: true,
    dependencies: record.dependencies,
  };
}

/** Install one optional grammar through its own integrity-locked pipeline. */
export async function installCallFlowLanguagePack(
  id: Exclude<CallFlowLanguageId, "javascript-typescript">,
  onStage: (stage: CallFlowInstallStage) => void = () => {},
): Promise<CallFlowRuntimeInstallResult> {
  return await withCallFlowInstallLock(() => installCallFlowLanguagePackUnlocked(id, onStage));
}

async function installCallFlowLanguagePackUnlocked(
  id: Exclude<CallFlowLanguageId, "javascript-typescript">,
  onStage: (stage: CallFlowInstallStage) => void,
): Promise<CallFlowRuntimeInstallResult> {
  const runtimeDir = getCallFlowManagedRuntimeDir();
  const language = getCallFlowLanguage(id);
  const nodePath = findExecutable("node");
  const npmPath = findExecutable("npm");
  if (!nodePath || !npmPath) {
    return { ok: false, status: "failed", runtimeDir, message: `Call flow language support needs ${CALL_FLOW_NODE_REQUIREMENT} and npm on PATH.` };
  }
  const runtime = await resolveCallFlowRuntime();
  if (!runtime.ok || !runtime.runtime.managed || runtime.runtime.runtimeDir !== runtimeDir) {
    return { ok: false, status: "failed", runtimeDir, message: runtime.ok
      ? "Language packs cannot be installed into PLANNOTATOR_CALLDIFF_PATH."
      : runtime.message };
  }
  if (runtime.runtime.installedLanguageIds.includes(id)) {
    return { ok: true, status: "already-installed", runtimeDir, languageId: id, message: `${language.label} support is already installed.` };
  }

  const runtimeParent = dirname(runtimeDir);
  const installDir = await mkdtemp(join(runtimeParent, `.calldiff-${id}-install-`));
  const stagingCache = await mkdtemp(join(runtimeDir, `.grammar-cache-${id}-`));
  const packageRoot = join(installDir, "node_modules", ...(language.packageName ?? "").split("/"));
  const stagedPackageRoot = join(stagingCache, "node_modules", ...(language.packageName ?? "").split("/"));
  const finalPackageRoot = getLanguagePackageRoot(runtimeDir, language);
  const backupPackageRoot = `${finalPackageRoot}.previous-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(join(installDir, "package.json"), runtimeJson(packManifest(id)), "utf8");
    writeFileSync(join(installDir, "package-lock.json"), runtimeJson(CALL_FLOW_PACK_LOCKS[id]), "utf8");
    const verifiedArtifacts = await downloadVerifiedLockArtifacts(
      CALL_FLOW_PACK_LOCKS[id],
      join(installDir, ".verified-artifacts"),
      onStage,
    );
    const npmCacheDir = await seedVerifiedNpmCache(npmPath, installDir, verifiedArtifacts);
    onStage("installing-deps");
    const install = await runCommand(npmPath, [
      "ci", "--offline", "--cache", npmCacheDir,
      "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--legacy-peer-deps",
    ], {
      cwd: installDir,
      timeoutMs: 240_000,
      maxOutputBytes: 4 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_offline: "true",
        NPM_CONFIG_OFFLINE: "true",
        npm_config_ignore_scripts: "true",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
    });
    if (install.exitCode !== 0) throw new Error(install.stderr.trim() || install.stdout.trim() || "npm ci failed");
    if (!installDirHasCommittedPackLock(installDir, id)) {
      throw new Error(`npm changed the committed ${language.label} dependency lock.`);
    }

    onStage("building");
    const rebuild = await runCommand(npmPath, [
      "rebuild", "--no-audit", "--no-fund", "--legacy-peer-deps", language.packageName ?? "",
    ], {
      cwd: installDir,
      timeoutMs: 240_000,
      maxOutputBytes: 4 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: "false", NPM_CONFIG_IGNORE_SCRIPTS: "false" },
    });
    if (rebuild.exitCode !== 0) throw new Error(rebuild.stderr.trim() || rebuild.stdout.trim() || "grammar rebuild failed");
    if (readPackageVersion(packageRoot) !== language.packageVersion) {
      throw new Error(`${language.label} did not install at the repository-pinned version.`);
    }
    const sizeBeforePruneBytes = measureCallFlowDirectoryBytes(packageRoot);
    pruneCallFlowNativePackage(packageRoot);
    const sizeAfterPruneBytes = measureCallFlowDirectoryBytes(packageRoot);
    mkdirSync(dirname(stagedPackageRoot), { recursive: true });
    cpSync(packageRoot, stagedPackageRoot, { recursive: true });
    ensureGrammarCacheManifest(stagingCache);
    await validatePrunedLanguage(nodePath, runtimeDir, stagingCache, [id]);

    ensureGrammarCacheManifest(getCallFlowGrammarCacheDir(runtimeDir));
    mkdirSync(dirname(finalPackageRoot), { recursive: true });
    if (existsSync(finalPackageRoot)) renameSync(finalPackageRoot, backupPackageRoot);
    try {
      renameSync(stagedPackageRoot, finalPackageRoot);
      mkdirSync(dirname(getLanguageLockMarker(runtimeDir, id)), { recursive: true });
      writeFileSync(getLanguageLockMarker(runtimeDir, id), runtimeJson(CALL_FLOW_PACK_LOCKS[id]), "utf8");
    } catch (error) {
      removeDirectoryBestEffort(finalPackageRoot);
      if (existsSync(backupPackageRoot)) renameSync(backupPackageRoot, finalPackageRoot);
      throw error;
    }
    removeDirectoryBestEffort(backupPackageRoot);
    return { ok: true, status: "installed", runtimeDir, languageId: id, sizeBeforePruneBytes, sizeAfterPruneBytes, message: `Installed pruned ${language.label} support.` };
  } catch (error) {
    return { ok: false, status: "failed", runtimeDir, message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) };
  } finally {
    removeDirectoryBestEffort(installDir);
    removeDirectoryBestEffort(stagingCache);
  }
}

async function runCommand(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; input?: string; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let aborted = false;
    const kill = (): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (process.platform === "win32" && child.pid) {
          const killed = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            env: childEnv(),
            stdio: "ignore",
            windowsHide: true,
          });
          if (killed.status !== 0) child.kill("SIGKILL");
        } else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* process already exited */ }
      }
    };
    const append = (current: string, currentBytes: number, chunk: Buffer): { value: string; bytes: number } => {
      if (stdoutBytes + stderrBytes + chunk.length > maxOutputBytes) {
        outputLimitExceeded = true;
        kill();
        return { value: current, bytes: currentBytes };
      }
      return { value: current + chunk.toString("utf8"), bytes: currentBytes + chunk.length };
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const next = append(stdout, stdoutBytes, chunk);
      stdout = next.value;
      stdoutBytes = next.bytes;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = append(stderr, stderrBytes, chunk);
      stderr = next.value;
      stderrBytes = next.bytes;
    });
    child.on("error", (error) => {
      const next = append(stderr, stderrBytes, Buffer.from(error.message));
      stderr = next.value;
      stderrBytes = next.bytes;
    });
    // A killed process or failed spawn can reject stdin while the child error
    // is already being handled above. Do not let that secondary EPIPE escape.
    child.stdin.on("error", () => {});
    const abort = (): void => {
      aborted = true;
      kill();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs) : null;
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        aborted,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function grammarChecksForLanguages(runtime: CallFlowRuntime, ids: readonly CallFlowLanguageId[]): Array<{
  packageJson: string;
  version: string;
  message: string;
}> {
  const checks = new Map<string, { packageJson: string; version: string; message: string }>();
  const callDiffRoot = runtime.managed
    ? join(runtime.runtimeDir, "node_modules", "calldiff")
    : runtime.runtimeDir;
  checks.set("calldiff", {
    packageJson: join(callDiffRoot, "package.json"),
    version: CALLDIFF_VERSION,
    message: `CallDiff ${CALLDIFF_VERSION} is not installed.`,
  });
  // These are the core runtime boundary even for a review that currently
  // analyzes only an optional language. CallDiff imports its grammar loader
  // before runDiff(), so the worker validates every hard dependency first.
  for (const dependency of CORE_RUNTIME_DEPENDENCIES) {
    checks.set(dependency.packageName, {
      packageJson: join(runtime.runtimeDir, "node_modules", dependency.packageName, "package.json"),
      version: dependency.version,
      message: `${dependency.label} support is not installed at the required version.`,
    });
  }
  for (const id of ids) {
    const language = getCallFlowLanguage(id);
    if (language.kind !== "pack" || !language.packageName || !language.packageVersion) continue;
    const packageRoot = runtime.managed
      ? getLanguagePackageRoot(runtime.runtimeDir, language)
      : join(runtime.runtimeDir, "node_modules", ...language.packageName.split("/"));
    checks.set(language.packageName, {
      packageJson: join(packageRoot, "package.json"),
      version: language.packageVersion,
      message: `${language.label} support is not installed.`,
    });
  }
  return [...checks.values()];
}

async function createNpmBlocker(): Promise<{ path: string; cleanup: () => void }> {
  const root = await mkdtemp(join(tmpdir(), "plannotator-call-flow-path-"));
  if (process.platform === "win32") {
    writeFileSync(join(root, "npm.cmd"), "@echo CallDiff package installation is disabled during analysis. 1>&2\r\n@exit /b 91\r\n", "utf8");
    writeFileSync(join(root, "npm.exe"), "", "utf8");
  } else {
    const blocker = join(root, "npm");
    writeFileSync(blocker, "#!/bin/sh\necho 'CallDiff package installation is disabled during analysis.' >&2\nexit 91\n", "utf8");
    chmodSync(blocker, 0o700);
  }
  return { path: root, cleanup: () => removeDirectoryBestEffort(root) };
}

async function executeWorker(
  runtime: CallFlowRuntime,
  plan: SnapshotPlan,
  paths: readonly string[],
  languageIds: readonly CallFlowLanguageId[],
  signal: AbortSignal,
): Promise<ParsedCallDiffWorkerResult> {
  const request = JSON.stringify({
    packageEntry: runtime.packageEntry,
    version: runtime.version,
    cwd: plan.cwd,
    from: plan.from,
    to: plan.to,
    maxDepth: 10,
    paths,
    grammars: grammarChecksForLanguages(runtime, languageIds),
  });
  const npmBlocker = await createNpmBlocker();
  let result: CommandResult;
  try {
    result = await runCommand(runtime.nodePath, [
      "--max-old-space-size=512",
      "--input-type=module",
      "--eval",
      WORKER_SOURCE,
    ], {
      cwd: runtime.runtimeDir,
      input: request,
      timeoutMs: WORKER_TIMEOUT_MS,
      signal,
      env: {
        ...process.env,
        // CallDiff runs git itself; keep a user's `color.diff = always` from
        // wrapping its diff in ANSI escapes (#1661).
        ...gitColorFreeEnvironment(process.env),
        PATH: `${npmBlocker.path}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        CALLDIFF_GRAMMAR_CACHE: runtime.grammarCacheDir,
        npm_config_offline: "true",
        NPM_CONFIG_OFFLINE: "true",
        npm_config_ignore_scripts: "true",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
    });
  } finally {
    npmBlocker.cleanup();
  }
  if (result.aborted) throw new Error("Call-flow analysis was superseded by a newer review snapshot.");
  if (result.timedOut) throw new Error("CallDiff exceeded the 45 second analysis limit.");
  if (result.outputLimitExceeded) throw new Error("CallDiff result exceeded Plannotator's 12 MB output limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error((result.stderr.trim() || "CallDiff worker returned invalid JSON.").slice(0, 2_000));
  }
  if (
    typeof parsed === "object"
    && parsed !== null
    && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).reason === "missing-grammar"
  ) {
    const message = (parsed as Record<string, unknown>).message;
    throw new CallFlowMissingGrammarError(typeof message === "string" ? message : "Call flow language support is not installed.");
  }
  return parseCallDiffWorkerResult(parsed);
}

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 64 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`).slice(0, 2_000));
  }
  return result.stdout;
}

async function snapshotPathsForLanguages(
  plan: SnapshotPlan,
  languageIds: ReadonlySet<CallFlowLanguageId>,
): Promise<string[]> {
  const files = new Set<string>();
  for (const ref of [plan.from, plan.to]) {
    const output = await gitRaw(plan.cwd, ["ls-tree", "-r", "--name-only", "-z", ref]);
    for (const filePath of output.split("\0")) {
      const language = getCallFlowLanguageForPath(filePath);
      if (language && languageIds.has(language.id)) files.add(filePath);
    }
  }
  return [...files].sort();
}

async function executeCallFlowAnalysis(
  runtime: CallFlowRuntime,
  input: CallFlowAnalysisInput,
  signal: AbortSignal,
): Promise<ParsedCallDiffWorkerResult> {
  let plan: SnapshotPlan | undefined;
  try {
    const installed = new Set(runtime.installedLanguageIds);
    const analyzedLanguageIds = getCallFlowPatchLanguageUsage(input.rawPatch)
      .map(({ language }) => language.id)
      .filter((id) => installed.has(id));
    const includedExtensions = analyzedLanguageIds.flatMap((id) => getCallFlowLanguage(id).extensions);
    plan = await input.snapshot.materialize({ includedExtensions, signal });
    if (signal.aborted) throw new Error("Call-flow analysis was superseded by a newer review snapshot.");
    if (analyzedLanguageIds.length === 0) {
      return {
        version: runtime.version,
        from: plan.from,
        to: plan.to,
        message: "No installed language support matched the changed files.",
        raw: "",
        trees: [],
        diagnostics: [],
      };
    }
    const paths = await snapshotPathsForLanguages(plan, new Set(analyzedLanguageIds));
    if (paths.length === 0) {
      return {
        version: runtime.version,
        from: plan.from,
        to: plan.to,
        message: "No supported source files were found in the review snapshots.",
        raw: "",
        trees: [],
        diagnostics: [],
      };
    }
    return await executeWorker(runtime, plan, paths, analyzedLanguageIds, signal);
  } finally {
    plan?.cleanup();
  }
}

/** Injectable boundaries used to verify CallFlowService concurrency and cache policy. */
export interface CallFlowServiceOptions {
  readonly now?: () => number;
  readonly runtimeProbeTtlMs?: number;
  readonly resolveRuntime?: () => Promise<CallFlowRuntimeResolution>;
  readonly executeAnalysis?: (
    runtime: CallFlowRuntime,
    input: CallFlowAnalysisInput,
    signal: AbortSignal,
  ) => Promise<ParsedCallDiffWorkerResult>;
}

/** Session-local cache + single execution slot for a review server. */
export class CallFlowService {
  private readonly cache = new Map<string, Extract<CallFlowResponse, { status: "ok" }>>();
  private readonly failureCache = new Map<string, { expiresAt: number; response: CallFlowResponse }>();
  private readonly inFlight = new Map<string, Promise<CallFlowResponse>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly runtimeProbeTtlMs: number;
  private readonly resolveRuntime: () => Promise<CallFlowRuntimeResolution>;
  private readonly executeAnalysis: NonNullable<CallFlowServiceOptions["executeAnalysis"]>;
  private runtimeProbe: { expiresAt: number; result: Promise<CallFlowRuntimeResolution> } | undefined;
  private queue: Promise<void> = Promise.resolve();

  /** Create one session-owned service; omitted boundaries use the production runtime. */
  constructor(options: CallFlowServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.runtimeProbeTtlMs = options.runtimeProbeTtlMs ?? 30_000;
    this.resolveRuntime = options.resolveRuntime ?? resolveCallFlowRuntime;
    this.executeAnalysis = options.executeAnalysis ?? executeCallFlowAnalysis;
  }

  private analysisKey(input: CallFlowAnalysisInput): string {
    return input.snapshotId;
  }

  async getAdvert(enabled: boolean, input?: { snapshotSupported: boolean; rawPatch: string }): Promise<CallFlowAdvert> {
    if (input && !input.snapshotSupported) {
      return {
        enabled,
        available: false,
        state: enabled ? "unsupported" : "disabled",
        provider: "calldiff",
        reason: "view-unsupported",
        message: "Call flow is not available for this review view.",
      };
    }
    const usage = getCallFlowPatchLanguageUsage(input?.rawPatch ?? "");
    const required = new Map(usage.map(({ language, files }) => [language.id, files.length]));
    if (!enabled) {
      const managed = !process.env.PLANNOTATOR_CALLDIFF_PATH;
      const consentIds = [
        CALL_FLOW_CORE_LANGUAGE_ID,
        ...usage.filter(({ language }) => language.kind === "pack").map(({ language }) => language.id),
      ];
      const languageIds = [...new Set(consentIds)];
      return {
        enabled: false,
        available: false,
        state: "disabled",
        provider: "calldiff",
        installable: managed,
        ...(managed && {
          consentPlan: {
            languageIds,
            labels: languageIds.map((id) => getCallFlowLanguage(id).label),
            changedFiles: usage.reduce((total, { files }) => total + files.length, 0),
            installSizeBytes: languageIds.reduce((total, id) => total + getCallFlowLanguage(id).installSizeBytes, 0),
          },
        }),
      };
    }
    const resolved = await this.resolveRuntimeCached();
    const managedInstallState = !process.env.PLANNOTATOR_CALLDIFF_PATH && [
      "node-unavailable",
      "node-version",
      "runtime-unavailable",
      "revision-mismatch",
      "runtime-lock-mismatch",
      "core-incomplete",
    ].includes(resolved.ok ? "" : resolved.reason);
    const installed = new Set(resolved.ok ? resolved.runtime.installedLanguageIds : []);
    const languages = CALL_FLOW_LANGUAGES.map((language) => ({
      id: language.id,
      label: language.label,
      kind: language.kind,
      installed: installed.has(language.id),
      required: required.has(language.id),
      changedFiles: required.get(language.id) ?? 0,
      installSizeBytes: language.installSizeBytes,
    }));
    const missingRequired = languages.filter((language) => language.required && !language.installed);
    const installIds = resolved.ok
      ? missingRequired.map((language) => language.id)
      : managedInstallState
        ? [CALL_FLOW_CORE_LANGUAGE_ID, ...missingRequired.filter((language) => language.kind === "pack").map((language) => language.id)]
        : [];
    const installPlan = installIds.length > 0 ? {
      languageIds: [...new Set(installIds)],
      labels: [...new Set(installIds.map((id) => getCallFlowLanguage(id).label))],
      changedFiles: missingRequired.reduce((total, language) => total + language.changedFiles, 0),
      installSizeBytes: [...new Set(installIds)].reduce((total, id) => total + getCallFlowLanguage(id).installSizeBytes, 0),
    } : undefined;
    if (!resolved.ok) {
      return {
        enabled: true,
        available: false,
        state: "unavailable",
        provider: "calldiff",
        reason: resolved.reason,
        message: resolved.message,
        installable: managedInstallState,
        languages,
        ...(installPlan && { installPlan }),
      };
    }
    return {
      enabled: true,
      available: true,
      state: "available",
      provider: "calldiff",
      version: resolved.runtime.version,
      installable: resolved.runtime.managed,
      languages,
      ...(installPlan && { installPlan }),
    };
  }

  analyze(input: CallFlowAnalysisInput): Promise<CallFlowResponse> {
    const key = this.analysisKey(input);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const failed = this.failureCache.get(key);
    if (failed && failed.expiresAt > this.now()) return Promise.resolve(failed.response);
    if (failed) this.failureCache.delete(key);
    const running = this.inFlight.get(key);
    const runningController = this.controllers.get(key);
    if (running && !runningController?.signal.aborted) return running;
    for (const [analysisKey, controller] of this.controllers) {
      if (analysisKey !== key) controller.abort();
    }
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const work = this.withSlot(() => this.analyzeUncached(input, controller.signal));
    this.inFlight.set(key, work);
    void work.then(
      (response) => {
        if (response.status === "error") {
          this.failureCache.set(key, { expiresAt: this.now() + 30_000, response });
          while (this.failureCache.size > 4) {
            const oldest = this.failureCache.keys().next().value;
            if (oldest === undefined) break;
            this.failureCache.delete(oldest);
          }
        }
        this.finish(key, controller);
      },
      () => this.finish(key, controller),
    );
    return work;
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  /**
   * Drop the cached runtime probe so the next capability advert re-resolves
   * from disk. Called when an in-app runtime install completes; without this,
   * the 30 second probe cache would keep advertising unavailable after a
   * successful install.
   */
  invalidateRuntimeProbe(): void {
    this.runtimeProbe = undefined;
  }

  /**
   * Reconcile a completed core/pack install with the live review session.
   * A partial result for this same snapshot must not survive the install or
   * the client retry would replay its old skipped-language set.
   */
  invalidateRuntimeState(): void {
    this.cancelAll();
    this.runtimeProbe = undefined;
    this.cache.clear();
    this.failureCache.clear();
  }

  private finish(key: string, controller: AbortController): void {
    if (this.controllers.get(key) !== controller) return;
    this.controllers.delete(key);
    this.inFlight.delete(key);
  }

  private async withSlot<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private resolveRuntimeCached(): Promise<CallFlowRuntimeResolution> {
    const current = this.runtimeProbe;
    if (current && current.expiresAt > this.now()) return current.result;
    const result = this.resolveRuntime();
    this.runtimeProbe = { expiresAt: this.now() + this.runtimeProbeTtlMs, result };
    return result;
  }

  private async analyzeUncached(input: CallFlowAnalysisInput, signal: AbortSignal): Promise<CallFlowResponse> {
    if (signal.aborted) {
      return { status: "stale", reason: "snapshot-superseded", message: "Call-flow analysis was superseded by a newer review snapshot." };
    }
    const runtime = await this.resolveRuntimeCached();
    if (!runtime.ok) return { status: "unavailable", reason: runtime.reason, message: runtime.message };
    try {
      const parsed = await this.executeAnalysis(runtime.runtime, input, signal);
      const installed = new Set(runtime.runtime.installedLanguageIds);
      const skippedLanguages = getCallFlowPatchLanguageUsage(input.rawPatch)
        .filter(({ language }) => !installed.has(language.id))
        .map(({ language, files }) => ({
          id: language.id,
          label: language.label,
          files: [...files],
          installSizeBytes: language.installSizeBytes,
        }));
      const indexed = indexCallFlowImpacts(parsed.trees);
      const response: Extract<CallFlowResponse, { status: "ok" }> = {
        status: "ok",
        snapshotId: input.snapshotId,
        provider: "calldiff",
        version: parsed.version,
        from: parsed.from,
        to: parsed.to,
        ...(parsed.message && { message: parsed.message }),
        raw: parsed.raw,
        trees: parsed.trees,
        fileImpacts: indexed.fileImpacts,
        summary: { ...indexed.summary, warnings: parsed.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length },
        diagnostics: parsed.diagnostics,
        skippedLanguages,
      };
      if (signal.aborted) {
        return { status: "stale", reason: "snapshot-superseded", message: "Call-flow analysis was superseded by a newer review snapshot." };
      }
      if (input.verifySnapshot && !(await input.verifySnapshot())) {
        return { status: "stale", reason: "snapshot-changed", message: "The files changed during call-flow analysis. Refresh and run it again." };
      }
      this.cache.set(this.analysisKey(input), response);
      while (this.cache.size > 4) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return response;
    } catch (error) {
      if (signal.aborted) {
        return { status: "stale", reason: "snapshot-superseded", message: "Call-flow analysis was superseded by a newer review snapshot." };
      }
      if (error instanceof CallFlowMissingGrammarError) {
        this.invalidateRuntimeProbe();
        return { status: "unavailable", reason: error.reason, message: error.message };
      }
      return { status: "error", reason: "analysis-failed", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
