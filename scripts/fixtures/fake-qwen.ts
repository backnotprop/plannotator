/**
 * A fake `qwen` for the installer tests. It acts like the parts of Qwen
 * Code's CLI the installers use, on $QWEN_HOME (default ~/.qwen), and logs
 * every call as "<cwd>|<args>" to $FAKE_QWEN_LOG. The tests start it through
 * a shim: a shell script on POSIX, a qwen.cmd on Windows (like npm's).
 *
 * What it models from Qwen's source (v0.26.2):
 * - `--version` prints the version ($FAKE_QWEN_VERSION, default 0.26.2).
 * - `extensions install <path> [--consent]` copies the folder into
 *   extensions/plannotator, records the source in .qwen-extension-install.json
 *   and writes a fresh "enabled" policy to extension-store/state.json. It
 *   refuses an installed extension, and without --consent reads y/n on stdin.
 * - `extensions uninstall plannotator` deletes the folder and the policy, as
 *   Qwen does (so a turned-off extension would come back on with an install).
 * - `extensions update plannotator` re-reads the recorded source and copies it
 *   when its version differs. It keeps the policy, refuses a linked extension,
 *   and exits 0 even when it fails (Qwen writes the error to stderr).
 *
 * FAKE_QWEN_HOME names the sandbox home (required). Failure knobs: FAKE_QWEN_HANG (any command waits 30 s), FAKE_QWEN_INSTALL_FAIL,
 * FAKE_QWEN_UNINSTALL_FAIL, FAKE_QWEN_UPDATE_FAIL.
 */
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_QWEN_LOG) appendFileSync(process.env.FAKE_QWEN_LOG, `${process.cwd()}|${args.join(" ")}\n`);

// The home folder Qwen would use. The tests name their sandbox home in
// FAKE_QWEN_HOME; without it the fake refuses to run, so it can never act on
// a real home folder.
function sandboxHome(): string {
  const value = process.env.FAKE_QWEN_HOME;
  if (!value) fail("fake qwen: FAKE_QWEN_HOME is not set", 3);
  return value;
}

function qwenHome(): string {
  const value = process.env.QWEN_HOME;
  if (!value) return join(sandboxHome(), ".qwen");
  if (value === "~") return sandboxHome();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(sandboxHome(), value.slice(2));
  return value;
}

const home = qwenHome();
const dest = join(home, "extensions", "plannotator");
const record = join(dest, ".qwen-extension-install.json");
const statePath = join(home, "extension-store", "state.json");

type Policy = { name: string; defaultActivation: string; workspaceOverrides: Record<string, string> };
type State = { version: 2; generation: number; extensions: Record<string, Policy> };

function readState(): State {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as State;
  } catch {
    return { version: 2, generation: 0, extensions: {} };
  }
}

function writeState(state: State): void {
  mkdirSync(join(home, "extension-store"), { recursive: true });
  state.generation += 1;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function versionOf(dir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "qwen-extension.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

// Qwen derives the id from the name and the recorded source.
const idFor = (source: string) => createHash("sha256").update(`plannotator\0${source}`).digest("hex").slice(0, 16);

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string, code = 1): never {
  process.stderr.write(`${line}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  if (process.env.FAKE_QWEN_HANG) await new Promise((resolve) => setTimeout(resolve, 30_000));
  if (args[0] === "--version") {
    out(process.env.FAKE_QWEN_VERSION ?? "0.26.2");
    return;
  }
  if (args[0] !== "extensions") fail(`unknown command: ${args.join(" ")}`, 2);
  const command = args[1];
  if (command === "install") {
    const source = args[2]!;
    if (args[3] !== "--consent") {
      const answer = readFileSync(0, "utf8").trim();
      if (answer !== "y") fail('Installation cancelled for "plannotator".');
    }
    if (process.env.FAKE_QWEN_INSTALL_FAIL) fail("Install failed: disk full");
    if (existsSync(join(dest, "qwen-extension.json")) || existsSync(record)) {
      fail('Extension "plannotator" is already installed. Please uninstall it first.');
    }
    if (!existsSync(join(source, "qwen-extension.json"))) fail(`Configuration file not found at ${source}`);
    mkdirSync(join(home, "extensions"), { recursive: true });
    cpSync(source, dest, { recursive: true });
    writeFileSync(record, JSON.stringify({ source, type: "local" }, null, 2));
    const state = readState();
    state.extensions[idFor(source)] = { name: "plannotator", defaultActivation: "enabled", workspaceOverrides: {} };
    writeState(state);
    out('Extension "plannotator" installed successfully and enabled.');
    return;
  }
  if (command === "uninstall") {
    if (process.env.FAKE_QWEN_UNINSTALL_FAIL) fail("Uninstall failed: busy");
    if (!existsSync(dest)) fail('Extension "plannotator" not found.');
    rmSync(dest, { recursive: true, force: true });
    const state = readState();
    for (const [id, policy] of Object.entries(state.extensions)) {
      if (policy.name === "plannotator") delete state.extensions[id];
    }
    writeState(state);
    out('Extension "plannotator" successfully uninstalled.');
    return;
  }
  if (command === "update") {
    // Qwen's `extensions update <name>` writes errors to stderr and exits 0.
    if (!existsSync(record)) {
      out('Extension "plannotator" not found.');
      return;
    }
    const meta = JSON.parse(readFileSync(record, "utf8")) as { source: string; type: string };
    if (meta.type === "link") {
      process.stderr.write("Extension is linked so does not need to be updated\n");
      return;
    }
    const next = versionOf(meta.source);
    if (next === undefined) {
      process.stderr.write(`Failed to check for update for local extension: ${meta.source} not found\n`);
      out('Extension "plannotator" is already up to date.');
      return;
    }
    const current = versionOf(dest);
    if (next === current) {
      out('Extension "plannotator" is already up to date.');
      return;
    }
    if (process.env.FAKE_QWEN_UPDATE_FAIL) {
      process.stderr.write("Update failed: disk full\n");
      return;
    }
    for (const entry of readdirSync(dest)) {
      if (entry !== ".qwen-extension-install.json") rmSync(join(dest, entry), { recursive: true, force: true });
    }
    cpSync(meta.source, dest, { recursive: true });
    out(`Extension "plannotator" successfully updated: ${current} → ${next}.`);
    return;
  }
  fail(`unknown extensions command: ${command}`, 2);
}

await main();
