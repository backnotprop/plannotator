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
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import {
  closeServer,
  deniedLowPort,
  occupyConsecutivePorts,
  reserveFreePort,
} from "../../../tests/helpers/live-port";

const serverDir = import.meta.dir;
const cliEntry = join(serverDir, "index.ts");

let fixtureDir: string;
let dataDir: string;
let stubs: string[] = [];

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

beforeAll(() => {
  stubs = stubHookDistHtml();

  fixtureDir = mkdtempSync(join(tmpdir(), "plannotator-annotate-cli-"));
  dataDir = join(fixtureDir, ".plannotator-data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(fixtureDir, "out"));
  writeFileSync(join(fixtureDir, "notes.md"), "# Notes");

  mkdirSync(join(fixtureDir, "bin"));
  writeFileSync(
    join(fixtureDir, "bin", "tailscale"),
    "#!/bin/sh\necho 'Log in to Tailscale first' >&2\nexit 1\n",
    { mode: 0o755 },
  );
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  removeStubbedHtml(stubs);
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
    const result = runAnnotate(["--no-jna", "https://example.invalid/doc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: --no-jna");
    expect(result.stdout).toBe("");
  });

  test("a quoted missing path is never re-split into a resolving token", () => {
    const result = runAnnotate(["my notes.md", "runme"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Could not resolve the arguments below");
    expect(result.stdout).toContain("my notes.md runme");
  });

  test("a stray word matching a directory cannot hijack the fast path", () => {
    const result = runAnnotate(["please", "annotate", "."]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Could not resolve the arguments below");
  });
});

describe("plannotator annotate: live app remote hard-off (CLI layer)", () => {
  test("a live-resolving loopback URL under PLANNOTATOR_REMOTE exits as a startup failure", async () => {
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

describe("annotate CLI on an occupied fixed port", () => {
  async function runOnOccupiedPort(extraArgs: string[]) {
    const blocker = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("busy") });
    try {
      const child = Bun.spawn([process.execPath, cliEntry, "annotate", "notes.md", ...extraArgs], {
        cwd: fixtureDir,
        env: {
          ...process.env,
          PLANNOTATOR_CWD: fixtureDir,
          PLANNOTATOR_DATA_DIR: dataDir,
          PLANNOTATOR_REMOTE: "1",
          PLANNOTATOR_PORT: String(blocker.port),
          PLANNOTATOR_BROWSER: NO_BROWSER,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await child.exited;
      return {
        port: blocker.port,
        exitCode,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    } finally {
      blocker.stop(true);
    }
  }

  test("exits 1 with one line naming the port and PLANNOTATOR_PORT, no stack", async () => {
    const result = await runOnOccupiedPort([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`port ${result.port} (PLANNOTATOR_PORT) is already in use`);
    expect(result.stderr.trim().split("\n").filter((line) => !line.startsWith("Resolved:"))).toHaveLength(1);
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stdout).toBe("");
  }, 20_000);

  test("is a gate startup failure (exit 2) under a strict annotate gate", async () => {
    const result = await runOnOccupiedPort(["--gate", "--json", "--require-approval"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("is already in use");
    expect(result.stdout).toBe("");
  }, 20_000);
});

describe("annotate CLI when the live proxy cannot bind (PLANNOTATOR_LIVE_PORT)", () => {
  async function runLive(livePort: string, extraArgs: string[] = []) {
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("<html><head></head><body>app</body></html>", {
        headers: { "Content-Type": "text/html" },
      }),
    });
    const editorPort = await reserveFreePort();
    try {
      const child = Bun.spawn(
        [process.execPath, cliEntry, "annotate", `http://localhost:${app.port}/`, ...extraArgs],
        {
          cwd: fixtureDir,
          env: {
            ...process.env,
            PLANNOTATOR_CWD: fixtureDir,
            PLANNOTATOR_DATA_DIR: dataDir,
            PLANNOTATOR_REMOTE: "0",
            PLANNOTATOR_PORT: String(editorPort),
            PLANNOTATOR_LIVE_PORT: livePort,
            NO_BROWSER,
            PLANNOTATOR_BROWSER: NO_BROWSER,
            PLANNOTATOR_INBOX_CONNECT: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await child.exited;
      return {
        exitCode,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    } finally {
      app.stop(true);
    }
  }

  function failureLines(stderr: string): string[] {
    return stderr.trim().split("\n").filter((line) => line && !line.startsWith("Resolved:"));
  }

  test("every port busy exits 1 with one line, no stack", async () => {
    const { start, servers } = await occupyConsecutivePorts(2);
    try {
      const result = await runLive(`${start}-${start + 1}`);
      expect(result.exitCode).toBe(1);
      expect(failureLines(result.stderr)).toEqual([
        `Plannotator: live app proxy every port in PLANNOTATOR_LIVE_PORT ${start}-${start + 1} is already in use. Close another live annotation session or set PLANNOTATOR_LIVE_PORT to a different port or range.`,
      ]);
      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(result.stdout).toBe("");
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  }, 20_000);

  test("is a gate startup failure (exit 2) under a strict annotate gate", async () => {
    const { start, servers } = await occupyConsecutivePorts(1);
    try {
      const result = await runLive(String(start), ["--gate", "--json", "--require-approval"]);
      expect(result.exitCode).toBe(2);
      expect(failureLines(result.stderr)).toEqual([
        `Plannotator: live app proxy port ${start} (PLANNOTATOR_LIVE_PORT) is already in use. Close another live annotation session or set PLANNOTATOR_LIVE_PORT to a different port or range.`,
      ]);
      expect(result.stdout).toBe("");
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  }, 20_000);

  test("a port this user may not bind is one line too (skipped as root)", async () => {
    const denied = await deniedLowPort();
    if (denied === null) {
      console.log("skip: no denied low port here (root, or low ports are open)");
      return;
    }
    const result = await runLive(String(denied));
    expect(result.exitCode).toBe(1);
    expect(failureLines(result.stderr)).toEqual([
      `Plannotator: live app proxy port ${denied} (PLANNOTATOR_LIVE_PORT) could not be used (EACCES: permission denied). Ports below 1024 usually need root. Set PLANNOTATOR_LIVE_PORT to a different port or range.`,
    ]);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  }, 20_000);
});

describe("annotate CLI keeps stdout clean while a session is live", () => {
  async function runUntilReady(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, cliEntry, "annotate", ...args], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        PLANNOTATOR_CWD: fixtureDir,
        PLANNOTATOR_DATA_DIR: dataDir,
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_BROWSER: NO_BROWSER,
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
      }
    };
    const drained = Promise.all([drain(child.stdout, "stdout"), drain(child.stderr, "stderr")]);
    const deadline = Date.now() + 30_000;
    while (!sinks.stderr.includes("Plannotator session ready: ") && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    await Bun.sleep(300);
    child.kill();
    await child.exited;
    await drained;
    return sinks;
  }

  test.each([
    ["--gate --json", ["notes.md", "--gate", "--json"]],
    ["--hook", ["notes.md", "--hook"]],
    ["--gate", ["notes.md", "--gate"]],
  ])("%s: the ready line goes to stderr, stdout stays empty", async (_label, args) => {
    const result = await runUntilReady(args as string[]);
    expect(result.stderr).toMatch(/\n {2}Plannotator session ready: http:\/\/localhost:\d+\n/);
    expect(result.stdout).toBe("");
  }, 40_000);
});
