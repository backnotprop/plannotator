/**
 * End-to-end exit-code and stream contract for `plannotator annotate`
 * argument handling (#1182), exercised through a real process spawn of the
 * CLI entry so the strict-gate bypass and the tolerant tiers are covered as
 * wired, not as helpers.
 *
 * The CLI entry imports the built single-file HTML from ../dist at module
 * load. Every case here fails or hands off before a server would start, so
 * placeholder dist files are enough; they are only created when a real build
 * is absent (CI) and are removed afterwards.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const serverDir = import.meta.dir;
const cliEntry = join(serverDir, "index.ts");
const distDir = join(serverDir, "..", "dist");
const distFiles = ["index.html", "review.html"];

let fixtureDir: string;
let dataDir: string;
const createdDistFiles: string[] = [];
let createdDistDir = false;

function runAnnotate(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(
    [process.execPath, cliEntry, "annotate", ...args],
    {
      cwd: fixtureDir,
      env: {
        ...process.env,
        PLANNOTATOR_CWD: fixtureDir,
        PLANNOTATOR_DATA_DIR: dataDir,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

beforeAll(() => {
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
    createdDistDir = true;
  }
  for (const file of distFiles) {
    const path = join(distDir, file);
    if (!existsSync(path)) {
      writeFileSync(path, "<!-- test placeholder -->");
      createdDistFiles.push(path);
    }
  }

  fixtureDir = mkdtempSync(join(tmpdir(), "plannotator-annotate-cli-"));
  dataDir = join(fixtureDir, ".plannotator-data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(fixtureDir, "out"));
  writeFileSync(join(fixtureDir, "notes.md"), "# Notes");
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const path of createdDistFiles) {
    rmSync(path, { force: true });
  }
  if (createdDistDir) {
    rmSync(distDir, { recursive: true, force: true });
  }
});

describe("annotate CLI single-token failures stay legacy", () => {
  test("a lone typo'd path exits 1 with File not found on stderr", () => {
    const result = runAnnotate(["nope.md"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: nope.md");
    expect(result.stdout).toBe("");
  });

  test("same with --gate (non-strict): still exit 1, no handoff prose", () => {
    const result = runAnnotate(["nope.md", "--gate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: nope.md");
    expect(result.stdout).toBe("");
  });
});

describe("annotate CLI strict gate bypasses tolerance", () => {
  test("--require-approval with natural-language args exits 2, stdout empty", () => {
    const result = runAnnotate([
      "the",
      "aim",
      "doc",
      "--gate",
      "--json",
      "--require-approval",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("File not found: the");
    expect(result.stdout).toBe("");
  });

  test("--result-file with natural-language args exits 2, stdout empty", () => {
    const result = runAnnotate([
      "the",
      "aim",
      "doc",
      "--gate",
      "--json",
      "--result-file",
      join("out", "result.json"),
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("File not found: the");
    expect(result.stdout).toBe("");
  });
});

describe("annotate CLI tolerant tiers", () => {
  test("multiple unresolvable words hand off on stdout with exit 0", () => {
    const result = runAnnotate(["the", "aim", "doc"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Could not resolve the arguments below");
    expect(result.stdout).toContain("the aim doc");
    expect(result.stdout).toContain("If you are an agent reading this");
  });

  test("an unrecognized flag disables tolerance and errors like base", () => {
    // --no-jna is a typo'd --no-jina; skipping it would silently fetch the
    // URL via Jina, exactly what the flag exists to prevent.
    const result = runAnnotate(["--no-jna", "https://example.invalid/doc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: --no-jna");
    expect(result.stdout).toBe("");
  });

  test("a quoted missing path is never re-split into a resolving token", () => {
    // notes.md exists; "my notes.md" (one argv token) does not. Token
    // boundaries must be preserved so this hands off instead of silently
    // opening notes.md.
    const result = runAnnotate(["my notes.md", "runme"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Could not resolve the arguments below");
    expect(result.stdout).toContain("my notes.md runme");
  });

  test("a stray word matching a directory cannot hijack the fast path", () => {
    // "." is a real directory; in multi-token mode bare directory names are
    // not candidates, so this hands off instead of opening folder mode.
    const result = runAnnotate(["please", "annotate", "."]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Could not resolve the arguments below");
  });
});
