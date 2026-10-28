/**
 * No test reaches the real GitHub CLI (`gh`) or its config.
 *
 * Every bun test run (this file is the first preload in every bunfig.toml,
 * guarded by tests/package-bunfig.test.ts) puts a tripwire `gh` first on
 * PATH. The tripwire never calls the real gh: it appends the command to a log
 * in this run's scratch folder, says on stderr what happened, and exits 1.
 * The run also points GH_CONFIG_DIR at an empty scratch folder, sets GH_TOKEN
 * and GH_ENTERPRISE_TOKEN to a fake token, and unsets GITHUB_TOKEN and
 * GITHUB_ENTERPRISE_TOKEN (which gh would read after GH_TOKEN and
 * GH_ENTERPRISE_TOKEN). The fake token matters: with no token in the
 * environment and none in its config, gh reads the system keyring
 * (TokenFromKeyring, `gh:<host>`, the macOS keychain), so an empty config
 * alone still lets a gh reached some other way (an absolute path, or a PATH a
 * test set) act as the developer. An environment token wins over the keyring,
 * so such a gh sends the fake token and is refused.
 *
 * A test that sets process.env.PATH to a fixed value (a folder of fakes, or
 * an empty folder) drops the tripwire from PATH; a gh found there, or by
 * absolute path, is caught only by that config and fake-token scrub, not by
 * the check below.
 *
 * Why a check after every test, not only the exit code: code under test
 * usually treats a failing `gh` as "not signed in" and goes on (the review
 * server's `gh api user`, for one), so a test that ran gh still passes. The
 * global afterEach below fails the test during which the tripwire was run,
 * with the command it ran, and the global afterAll fails the run for a call
 * made after the last test (a process still running then). Bun runs every
 * test file in one process, so these hooks see every test; a child
 * `bun test` loads its own preloads and checks itself.
 *
 * Why the spawn functions are wrapped: Bun resolves `Bun.spawn` and
 * `Bun.spawnSync` called WITHOUT `env` against the PATH, and hands the child
 * the environment, the process STARTED with (on bun 1.3.14, node's spawnSync
 * / execFileSync / execSync did too; from 1.4.4 they use the current one).
 * Measured on bun 1.3.14 and 1.4.4: changing process.env.PATH, even in this
 * preload, changes neither, so the tripwire on PATH would be skipped and the
 * child would get the real GH_CONFIG_DIR and tokens. A preload cannot change the startup environment (re-running bun
 * test is not possible: a preload's process.argv lists the test files, not
 * the command line), so `Bun.spawn`, `Bun.spawnSync` and `Bun.which` default
 * to the current process.env here, as their documentation says they do.
 * node's async spawn / exec / execFile already use the current environment.
 * Not covered on bun 1.3.14: Bun Shell (`$` from "bun") looks commands up on
 * the startup PATH (1.4.4 uses the current one); no source runs gh through it.
 *
 * Windows: the tripwire is `gh.cmd`. A spawn that does not go through a
 * shell may skip a .cmd file (node's own spawn does since CVE-2024-27980) and
 * find a real gh.exe later on PATH, as on a CI runner with gh installed; not
 * verified for Bun's spawn. There only the config and fake-token scrub protect
 * the run, and the call is not logged. No gh.exe shim: an .exe beside the
 * .cmd would win the PATHEXT lookup and log nothing.
 *
 * Tests that need a gh inject a fake: a PR command runner
 * (tests/helpers/fake-pr-runtime.ts with setPRCommandRuntimeForTests), or a
 * fake `gh` script first on the PATH of the process they spawn.
 */
import { afterAll, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-test-gh-")));
const bin = join(scratch, "bin");
const log = join(scratch, "gh-calls.log");
const configDir = join(scratch, "gh-config");
mkdirSync(bin);
mkdirSync(configDir);
writeFileSync(log, "");

const MESSAGE = "plannotator test tripwire: a test ran `gh`. Tests never run the real GitHub CLI; inject a fake (tests/helpers/fake-pr-runtime.ts, or a fake gh first on the child's PATH).";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

if (process.platform === "win32") {
  writeFileSync(
    join(bin, "gh.cmd"),
    [
      "@echo off",
      // The arguments are never written into a line cmd parses (%* would act
      // on & | < > ^ in them): CMDCMDLINE, the whole command line, is expanded
      // late (!...!), after parsing, so its characters are only text.
      "setlocal EnableDelayedExpansion",
      `>>"${log}" echo(gh (cmd) !CMDCMDLINE!`,
      `>&2 echo(${MESSAGE.replace(/[`()<>&|^%!"]/g, "")}`,
      "exit /b 1",
      "",
    ].join("\r\n"),
  );
} else {
  const script = join(bin, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "# Plannotator's test tripwire (tests/setup/gh-tripwire.ts): never the real gh.",
      // One line per call, written at once, so calls running side by side never interleave.
      "line=gh",
      `for arg in "$@"; do line="$line $(printf '%s' "$arg" | tr '\\n\\t' '  ')"; done`,
      `printf '%s  (cwd %s)\\n' "$line" "$PWD" >> ${shellQuote(log)}`,
      `echo ${shellQuote(MESSAGE)} >&2`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
}

/** The scratch folder this run's tripwire `gh` lives in, and its log (tests/gh-tripwire.test.ts). */
export const GH_TRIPWIRE_BIN = bin;
export const GH_TRIPWIRE_LOG = log;
export const GH_TRIPWIRE_CONFIG_DIR = configDir;

process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
process.env.GH_CONFIG_DIR = configDir;
/** What GH_TOKEN and GH_ENTERPRISE_TOKEN hold in every test: never a real token, and never the keyring's. */
export const GH_FAKE_TOKEN = "plannotator-test-fake-token";
process.env.GH_TOKEN = GH_FAKE_TOKEN;
process.env.GH_ENTERPRISE_TOKEN = GH_FAKE_TOKEN;
for (const name of ["GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete process.env[name];
// gh never prompts, and never checks for its own updates over the network.
process.env.GH_PROMPT_DISABLED = "1";
process.env.GH_NO_UPDATE_NOTIFIER = "1";

type AnyOptions = Record<string, unknown> | undefined;

function withCurrentEnv<T extends AnyOptions>(options: T): T {
  if (options && options.env !== undefined) return options;
  return { ...(options ?? {}), env: process.env } as T;
}

const realSpawn = Bun.spawn;
const realSpawnSync = Bun.spawnSync;
const realWhich = Bun.which;

Bun.spawn = function spawn(cmdOrOptions: unknown, options?: AnyOptions) {
  if (Array.isArray(cmdOrOptions)) return realSpawn(cmdOrOptions as string[], withCurrentEnv(options) as never);
  return realSpawn(withCurrentEnv(cmdOrOptions as AnyOptions) as never);
} as typeof Bun.spawn;

Bun.spawnSync = function spawnSync(cmdOrOptions: unknown, options?: AnyOptions) {
  if (Array.isArray(cmdOrOptions)) return realSpawnSync(cmdOrOptions as string[], withCurrentEnv(options) as never);
  return realSpawnSync(withCurrentEnv(cmdOrOptions as AnyOptions) as never);
} as typeof Bun.spawnSync;

Bun.which = function which(command: string, options?: { PATH?: string; cwd?: string }) {
  return realWhich(command, options?.PATH !== undefined ? options : { ...options, PATH: process.env.PATH ?? "" });
} as typeof Bun.which;

let seen = 0;

/**
 * The tripwire calls logged since the last check, and moves past them. The
 * self-test runs the tripwire on purpose and takes its own calls with this.
 */
export function takeGhTripwireCalls(): string[] {
  let bytes: Buffer;
  try {
    if (statSync(log).size <= seen) return [];
    bytes = readFileSync(log);
  } catch {
    return [];
  }
  const fresh = bytes.subarray(seen).toString("utf-8");
  seen = bytes.length;
  return fresh.split("\n").filter(Boolean);
}

function failOnCalls(when: string): void {
  const calls = takeGhTripwireCalls();
  if (calls.length === 0) return;
  throw new Error(`${MESSAGE}\n${when} it ran:\n${calls.map((call) => `  ${call}`).join("\n")}`);
}

afterEach(() => failOnCalls("During this test (or just before it, from a process still running),"));

afterAll(() => {
  try {
    failOnCalls("After the last test,");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
