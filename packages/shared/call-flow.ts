/**
 * Isolated CallDiff execution and exact Git snapshot materialization.
 *
 * CallDiff is a Node-native, synchronous Tree-sitter library. Plannotator runs
 * it in a short-lived Node 22 worker and never imports it into Bun or Pi.
 */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import runtimePackageJson from "./call-flow-runtime/package.json" with { type: "json" };
import runtimePackageLock from "./call-flow-runtime/package-lock.json" with { type: "json" };
import { CALL_FLOW_PACK_LOCKS } from "./call-flow-pack-locks";
import {
  CALL_FLOW_CORE_LANGUAGE_ID,
  CALL_FLOW_LANGUAGES,
  getCallFlowLanguage,
  getCallFlowLanguageForPath,
  getCallFlowPatchLanguageUsage,
} from "./call-flow-languages";
import type { CallFlowLanguageDefinition, CallFlowLanguageId } from "./call-flow-languages";
import { getPlannotatorDataDir } from "./data-dir";
import { indexCallFlowImpacts, parseCallDiffWorkerResult } from "./call-flow-types";
import type {
  CallFlowAdvert,
  CallFlowInstallStage,
  CallFlowResponse,
  ParsedCallDiffWorkerResult,
} from "./call-flow-types";
import { parseCommitDiffType, parseWorktreeDiffType } from "./review-core";

export const CALLDIFF_VERSION = "0.4.1";
export const CALLDIFF_COMMIT = "a3194d20ca91ef6a314273d634e9b9c0db1c2707";
export const CALLDIFF_SOURCE_SPEC = `https://github.com/tanishqkancharla/calldiff/archive/${CALLDIFF_COMMIT}.tar.gz`;
export const CALLDIFF_SOURCE_INTEGRITY = "sha512-5y6tjre5UE00qPrVFPurnk9RBdk8WlRok+0w41lxLt1MyPLOlNUEaAT2/j/nz2xWlhDm3DfDYvW/5KBD2b9TLg==";
export const CALLDIFF_TREE_SITTER_VERSION = "0.25.1";
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
  cwd: string;
  diffType: string;
  base: string;
  rawPatch: string;
  vcsType?: string;
  /** Exact hosted-PR object pair, used only with a checkout that contains both. */
  prCommitPair?: { from: string; to: string };
  /** Revalidate mutable review state before an ok result can enter the cache. */
  verifySnapshot?: () => Promise<boolean>;
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

interface SnapshotPlan {
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

async function checkNode22(nodePath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await runCommand(nodePath, ["--version"], { timeoutMs: 3_000 });
  const match = /^v(\d+)/.exec(result.stdout.trim());
  if (result.exitCode !== 0 || !match) return { ok: false, message: "Node.js could not be started." };
  if (Number(match[1]) < 22) return { ok: false, message: `Node.js 22 or newer is required (found ${result.stdout.trim()}).` };
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
  if (!nodePath) return { ok: false, reason: "node-unavailable", message: "Call flow requires Node.js 22 or newer, which was not found on PATH." };
  const nodeCheck = await checkNode22(nodePath);
  if (!nodeCheck.ok) return { ok: false, reason: "node-version", message: nodeCheck.message };
  return { ok: true };
}

/** Resolve the pruned core and report independently installed language packs. */
export async function resolveCallFlowRuntime(): Promise<CallFlowRuntimeResolution> {
  const nodePath = findExecutable("node");
  if (!nodePath) return { ok: false, reason: "node-unavailable", message: "Call flow requires Node.js 22 or newer." };
  const nodeCheck = await checkNode22(nodePath);
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

async function preserveValidatedLanguagePacks(
  nodePath: string,
  currentRuntimeDir: string,
  candidateRuntimeDir: string,
): Promise<void> {
  const candidateCache = getCallFlowGrammarCacheDir(candidateRuntimeDir);
  ensureGrammarCacheManifest(candidateCache);
  for (const language of CALL_FLOW_LANGUAGES) {
    if (language.kind !== "pack" || !isLanguageInstalled(currentRuntimeDir, language, true)) continue;
    const packId = language.id as Exclude<CallFlowLanguageId, "javascript-typescript">;
    const currentRoot = getLanguagePackageRoot(currentRuntimeDir, language);
    const candidateRoot = getLanguagePackageRoot(candidateRuntimeDir, language);
    mkdirSync(dirname(candidateRoot), { recursive: true });
    cpSync(currentRoot, candidateRoot, { recursive: true, force: true });
    try {
      await validatePrunedLanguage(nodePath, candidateRuntimeDir, candidateCache, [language.id]);
      const marker = getLanguageLockMarker(candidateRuntimeDir, language.id);
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, runtimeJson(CALL_FLOW_PACK_LOCKS[packId]), "utf8");
    } catch {
      // A pack whose files no longer load is not independently verified and
      // must not cross the atomic core repair boundary.
      removeDirectoryStrict(candidateRoot);
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
  const runtimeDir = getCallFlowManagedRuntimeDir();
  const nodePath = findExecutable("node");
  const npmPath = findExecutable("npm");
  if (!nodePath || !npmPath) {
    return { ok: false, status: "failed", runtimeDir, message: "Call-flow runtime requires Node.js 22+ and npm." };
  }
  const nodeCheck = await checkNode22(nodePath);
  if (!nodeCheck.ok) return { ok: false, status: "failed", runtimeDir, message: nodeCheck.message };

  const existing = await resolveCallFlowRuntime();
  if (existing.ok && existing.runtime.runtimeDir === runtimeDir) {
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

    // A core repair preserves only packs whose exact marker, package version,
    // and native payload all still validate against the candidate core.
    const nextCache = getCallFlowGrammarCacheDir(installDir);
    await preserveValidatedLanguagePacks(nodePath, runtimeDir, installDir);
    ensureGrammarCacheManifest(nextCache);

    if (existsSync(runtimeDir)) renameSync(runtimeDir, backupDir);
    try {
      renameSync(installDir, runtimeDir);
    } catch (error) {
      if (existsSync(backupDir)) renameSync(backupDir, runtimeDir);
      throw error;
    }
    removeDirectoryBestEffort(backupDir);
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
  const runtimeDir = getCallFlowManagedRuntimeDir();
  const language = getCallFlowLanguage(id);
  const nodePath = findExecutable("node");
  const npmPath = findExecutable("npm");
  if (!nodePath || !npmPath) {
    return { ok: false, status: "failed", runtimeDir, message: "Call-flow language packs require Node.js 22+ and npm." };
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

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const result = await runCommand("git", args, { cwd, input, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 8 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`).slice(0, 2_000));
  }
  return result.stdout.trim();
}

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 64 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`).slice(0, 2_000));
  }
  return result.stdout;
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

async function firstParent(cwd: string, ref: string): Promise<string> {
  try {
    return await resolveCommit(cwd, `${ref}^`);
  } catch {
    throw new Error("Call flow is unavailable for a root commit because CallDiff requires two commit snapshots.");
  }
}

async function commitIndex(cwd: string, parent: string, message: string): Promise<string> {
  const tree = await git(cwd, ["write-tree"]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Plannotator",
    GIT_AUTHOR_EMAIL: "call-flow@plannotator.invalid",
    GIT_COMMITTER_NAME: "Plannotator",
    GIT_COMMITTER_EMAIL: "call-flow@plannotator.invalid",
  };
  const result = await runCommand("git", ["commit-tree", tree, "-p", parent, "-m", message], {
    cwd,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git commit-tree failed");
  return result.stdout.trim();
}

async function applyPatchToIndex(cwd: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
  await git(cwd, ["apply", "--cached", "--binary", "--recount", "--whitespace=nowarn", "-"], normalizedPatch);
}

async function createSyntheticPlan(
  sourceCwd: string,
  baseCommit: string,
  patches: readonly string[],
): Promise<SnapshotPlan> {
  const tempRoot = await mkdtemp(join(tmpdir(), "plannotator-call-flow-"));
  const cloneCwd = join(tempRoot, "repo");
  const cleanup = () => removeDirectoryBestEffort(tempRoot);
  try {
    await git(sourceCwd, ["clone", "--shared", "--no-checkout", "--quiet", "--", sourceCwd, cloneCwd]);
    await git(cloneCwd, ["read-tree", baseCommit]);
    let parent = baseCommit;
    const commits: string[] = [];
    for (let index = 0; index < patches.length; index += 1) {
      await applyPatchToIndex(cloneCwd, patches[index]);
      parent = await commitIndex(cloneCwd, parent, `Plannotator call-flow snapshot ${index + 1}`);
      commits.push(parent);
    }
    return {
      cwd: cloneCwd,
      from: commits.length > 1 ? commits[commits.length - 2] : baseCommit,
      to: commits[commits.length - 1] ?? baseCommit,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Map the visible review mode to the exact two immutable commits CallDiff needs. */
export async function createCallFlowSnapshotPlan(input: CallFlowAnalysisInput): Promise<SnapshotPlan> {
  if (input.vcsType && input.vcsType !== "git") {
    throw new Error(`Call flow does not yet support ${input.vcsType} reviews.`);
  }
  if (input.prCommitPair) {
    return {
      cwd: input.cwd,
      from: await resolveCommit(input.cwd, input.prCommitPair.from),
      to: await resolveCommit(input.cwd, input.prCommitPair.to),
      cleanup: () => {},
    };
  }

  const worktree = parseWorktreeDiffType(input.diffType);
  const cwd = worktree?.path ?? input.cwd;
  const diffType = worktree?.subType ?? input.diffType;
  const commit = parseCommitDiffType(diffType);
  if (commit) {
    const to = await resolveCommit(cwd, commit.sha);
    return { cwd, from: await firstParent(cwd, to), to, cleanup: () => {} };
  }

  if (diffType === "last-commit") {
    const to = await resolveCommit(cwd, "HEAD");
    return { cwd, from: await firstParent(cwd, to), to, cleanup: () => {} };
  }
  if (diffType === "branch") {
    return { cwd, from: await resolveCommit(cwd, input.base), to: await resolveCommit(cwd, "HEAD"), cleanup: () => {} };
  }
  if (diffType === "merge-base") {
    const from = await git(cwd, ["merge-base", "--", input.base, "HEAD"]);
    return { cwd, from, to: await resolveCommit(cwd, "HEAD"), cleanup: () => {} };
  }
  if (diffType === "all") {
    throw new Error("Call flow is unavailable for the All Files snapshot because it has no commit baseline.");
  }
  if (diffType === "since-base") {
    const mergeBase = await git(cwd, ["merge-base", "--", input.base, "HEAD"]);
    return createSyntheticPlan(cwd, mergeBase, [input.rawPatch]);
  }
  if (diffType === "uncommitted" || diffType === "staged") {
    return createSyntheticPlan(cwd, await resolveCommit(cwd, "HEAD"), [input.rawPatch]);
  }
  if (diffType === "unstaged") {
    const stagedPatch = await git(cwd, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"]);
    return createSyntheticPlan(cwd, await resolveCommit(cwd, "HEAD"), [stagedPatch, input.rawPatch]);
  }
  throw new Error(`Call flow does not yet support the ${diffType} review mode.`);
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
    plan = await createCallFlowSnapshotPlan(input);
    if (signal.aborted) throw new Error("Call-flow analysis was superseded by a newer review snapshot.");
    const installed = new Set(runtime.installedLanguageIds);
    const analyzedLanguageIds = getCallFlowPatchLanguageUsage(input.rawPatch)
      .map(({ language }) => language.id)
      .filter((id) => installed.has(id));
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
    const pair = input.prCommitPair ? `${input.prCommitPair.from}:${input.prCommitPair.to}` : "";
    return [input.snapshotId, input.cwd, input.diffType, input.base, pair].join("\0");
  }

  async getAdvert(enabled: boolean, input?: Pick<CallFlowAnalysisInput, "vcsType" | "diffType" | "rawPatch">): Promise<CallFlowAdvert> {
    if (!enabled) return { enabled: false, available: false, state: "disabled", provider: "calldiff" };
    if (input?.vcsType && input.vcsType !== "git") {
      return { enabled: true, available: false, state: "unsupported", provider: "calldiff", reason: "vcs-unsupported", message: `Call flow does not yet support ${input.vcsType} reviews.` };
    }
    const effective = parseWorktreeDiffType(input?.diffType ?? "")?.subType ?? input?.diffType;
    if (effective === "all" || effective?.startsWith("jj-") || effective?.startsWith("gitbutler:") || effective?.startsWith("p4-")) {
      return { enabled: true, available: false, state: "unsupported", provider: "calldiff", reason: "view-unsupported", message: "Call flow is not available for this review view." };
    }
    const resolved = await this.resolveRuntimeCached();
    const usage = getCallFlowPatchLanguageUsage(input?.rawPatch ?? "");
    const required = new Map(usage.map(({ language, files }) => [language.id, files.length]));
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
