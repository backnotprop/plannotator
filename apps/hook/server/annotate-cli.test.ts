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

function runAnnotate(args: string[], envOverrides: Record<string, string> = {}): {
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
        ...envOverrides,
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

/**
 * Start a real annotate session, wait for the ready line on stderr, then kill
 * it. Returns everything each stream received.
 *
 * The gate never settles on its own here (no client ever connects, and a
 * session that never received a first client does not auto-dismiss), so the
 * ready line is the only signal that the server came all the way up, and the
 * kill is how the session ends.
 */
async function runAnnotateUntilReady(args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, cliEntry, "annotate", ...args], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: fixtureDir,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_AI: "disabled",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const sinks = { stdout: "", stderr: "" };
  const drain = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) sinks[key] += decoder.decode(chunk, { stream: true });
    } catch {
      // The kill below tears the pipes down mid-read; whatever arrived is enough.
    }
  };
  const drained = Promise.all([drain(proc.stdout, "stdout"), drain(proc.stderr, "stderr")]);

  const deadline = Date.now() + 30_000;
  while (!sinks.stderr.includes("Plannotator session ready: ") && Date.now() < deadline) {
    await Bun.sleep(50);
  }

  proc.kill();
  await proc.exited;
  await drained;
  return { stdout: sinks.stdout, stderr: sinks.stderr };
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

  // Failing `tailscale` shim for the --tailscale publish-failure exit-code
  // tests: shadows any real CLI on PATH so no tailnet state is ever touched.
  mkdirSync(join(fixtureDir, "bin"));
  writeFileSync(
    join(fixtureDir, "bin", "tailscale"),
    "#!/bin/sh\necho 'Log in to Tailscale first' >&2\nexit 1\n",
    { mode: 0o755 },
  );
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

describe("annotate CLI --tailscale publish failure exit codes", () => {
  // The tailnet publish happens in onReady, after the loopback server is up,
  // through the failing shim above. Under a strict gate exit 1 is reserved
  // for "the reviewer did not approve, decision record published" — a
  // publish failure must present as a startup failure (exit 2, no record
  // file), never as a rejection. POSIX shim, so skipped on Windows.
  const testUnix = test.skipIf(process.platform === "win32");
  const tailscaleEnv = () => ({
    PATH: `${join(fixtureDir, "bin")}:${process.env.PATH ?? ""}`,
    PLANNOTATOR_AI: "disabled",
  });

  testUnix("strict gate: exits 2 with no result file", () => {
    const resultFile = join("out", "ts-result.json");
    const result = runAnnotate(
      ["notes.md", "--tailscale", "--gate", "--json", "--result-file", resultFile],
      tailscaleEnv(),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--tailscale");
    expect(result.stdout).toBe("");
    expect(existsSync(join(fixtureDir, resultFile))).toBe(false);
  });

  testUnix("non-strict: keeps the documented exit 1", () => {
    const result = runAnnotate(["notes.md", "--tailscale"], tailscaleEnv());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--tailscale");
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

describe("plannotator annotate: live app remote hard-off (CLI layer)", () => {
  test("a live-resolving loopback URL under PLANNOTATOR_REMOTE exits as a startup failure", async () => {
    // The fake app lives in THIS process, so the CLI must be spawned
    // asynchronously (a sync spawn would block the event loop and deadlock
    // the probe request against our own server).
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<html><head></head><body>app</body></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    });
    try {
      const child = Bun.spawn(
        [process.execPath, cliEntry, "annotate", `http://127.0.0.1:${app.port}/`],
        {
          cwd: fixtureDir,
          env: {
            ...process.env,
            PLANNOTATOR_CWD: fixtureDir,
            PLANNOTATOR_DATA_DIR: dataDir,
            PLANNOTATOR_REMOTE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Live app annotation is unavailable in remote mode");
      expect(stderr).toContain("--static");
    } finally {
      app.stop(true);
    }
  });
});

/**
 * The stdout contract for the always-printed session URL (#1134).
 *
 * `--json` and `--hook` reserve stdout for the decision record an agent
 * parses, so the ready announcement has to stay entirely on stderr. Asserted
 * through a real session rather than only at `handleServerReady`, because the
 * bytes an agent reads are the process's, not one function's: any startup
 * write on either the plain or the hook-native path would corrupt the record.
 */
describe("annotate CLI keeps stdout clean while a session is live", () => {
  test.each([
    ["json mode", ["notes.md", "--gate", "--json"]],
    ["hook mode", ["notes.md", "--hook"]],
  ])("%s: the ready line goes to stderr, stdout stays empty", async (_label, args) => {
    const result = await runAnnotateUntilReady(args as string[]);

    // Literal, not the exported constant: interpolating the constant would
    // assert it against itself and stay green if the text ever drifted.
    expect(result.stderr).toContain("Plannotator session ready: http://localhost:");
    expect(result.stdout).toBe("");
  }, 40_000);
});
