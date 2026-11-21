import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSDKProvider } from "./claude-agent-sdk.ts";

// A fake `claude` (never the real one): it writes the arguments the SDK gave
// it, one per line, and exits, so the session ends with an error.
const dir = mkdtempSync(join(tmpdir(), "plannotator-fake-claude-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeClaude(): { path: string; argv: () => string[] } {
  const log = join(dir, `argv-${Math.random().toString(36).slice(2)}.txt`);
  const path = join(dir, `claude-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nexit 1\n`);
  chmodSync(path, 0o755);
  return { path, argv: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

/** The value the SDK passed as `--setting-sources` (either `--x=v` or `--x v`), or undefined when it passed none. */
function settingSources(argv: string[]): string[] | undefined {
  const i = argv.findIndex((a) => a === "--setting-sources" || a.startsWith("--setting-sources="));
  if (i < 0) return undefined;
  const value = argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : argv[i + 1];
  return value.split(",").filter(Boolean);
}

async function argvOfOneQuery(config: { settingSources?: string[] }): Promise<string[]> {
  const cli = fakeClaude();
  const provider = new ClaudeAgentSDKProvider({ type: "claude-agent-sdk", cwd: dir, claudeExecutablePath: cli.path, ...config });
  const session = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Plan" } } });
  for await (const _ of session.query("hello")) {
    // Drain until the fake exits.
  }
  const argv = cli.argv();
  // The fake was run: an empty argv would make "no --setting-sources" pass for the wrong reason.
  expect(argv.length).toBeGreaterThan(0);
  return argv;
}

describe("Ask AI's Claude session loads settings exactly as `claude` does in that folder", () => {
  test.skipIf(process.platform === "win32")("passes no --setting-sources, so the CLI's default (every source) applies", async () => {
    expect(settingSources(await argvOfOneQuery({}))).toBeUndefined();
  }, 15_000);

  test.skipIf(process.platform === "win32")("a caller's explicit settingSources still reaches the CLI", async () => {
    expect(settingSources(await argvOfOneQuery({ settingSources: ["user"] }))).toEqual(["user"]);
    expect(settingSources(await argvOfOneQuery({ settingSources: [] }))).toEqual([]);
  }, 15_000);
});
