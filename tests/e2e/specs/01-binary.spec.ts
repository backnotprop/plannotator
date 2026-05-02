import { describe, test, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBinary, runCli } from "../helpers";

let binary: string;

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(SPEC_DIR, "__snapshots__");
const HELP_SNAPSHOT_PATH = resolve(SNAPSHOT_DIR, "help.txt");

const STACK_FRAME_RE = /^\s+at /m;

describe("01-binary surface", () => {
  beforeAll(async () => {
    binary = await buildBinary();
  }, 300_000);

  test("1.1 plannotator --version prints semver and exits 0", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stderr).toBe("");
  });

  test("1.2 plannotator --help lists every documented subcommand", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);

    const expectedFragments = [
      "daemon start",
      "daemon stop",
      "daemon status",
      "submit",
      "review",
      "annotate",
      "wait",
      "clear",
      "open",
    ];
    for (const fragment of expectedFragments) {
      expect(result.stdout).toContain(fragment);
    }

    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(HELP_SNAPSHOT_PATH, result.stdout, "utf8");
  });

  test("1.3 no args + non-TTY empty stdin does not crash", async () => {
    const result = await runCli([], { stdin: "" });
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain("TypeError");
    expect(combined).not.toContain("Error:");
    expect(combined).not.toMatch(STACK_FRAME_RE);
    expect(typeof result.exitCode).toBe("number");
  });

  test("1.4 unknown subcommand exits non-zero without a stack trace", async () => {
    const result = await runCli(["badcommand"]);
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toMatch(STACK_FRAME_RE);
    expect(combined.trim().length).toBeGreaterThan(0);
  });

  test("1.5 plannotator submit --help mentions submit-specific flags", async () => {
    const result = await runCli(["submit", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--mode");
    expect(result.stdout).toContain("--no-browser");
    expect(result.stdout).toContain("--commit-message");
    expect(result.stdout).toContain("--json");
  });

  test("1.6 plannotator review --help mentions --diff-type", async () => {
    const result = await runCli(["review", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--diff-type");
  });
});
