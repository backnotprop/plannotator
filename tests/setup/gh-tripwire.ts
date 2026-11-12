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

export const GH_TRIPWIRE_BIN = bin;
export const GH_TRIPWIRE_LOG = log;
export const GH_TRIPWIRE_CONFIG_DIR = configDir;

process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
process.env.GH_CONFIG_DIR = configDir;
export const GH_FAKE_TOKEN = "plannotator-test-fake-token";
process.env.GH_TOKEN = GH_FAKE_TOKEN;
process.env.GH_ENTERPRISE_TOKEN = GH_FAKE_TOKEN;
for (const name of ["GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete process.env[name];
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
