import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = "http://localhost:4321";
const posix = process.platform !== "win32";

let root: string;
let bin: string;
let log: string;
let dataDir: string;
let childScript: string;
let recordingBrowser: string;
let ipcHits: string[] = [];
let ipcServer: ReturnType<typeof Bun.serve> | undefined;

function stub(name: string): string {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\n`, { mode: 0o755 });
  return path;
}

function launches(): string {
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-browser-intent-"));
  bin = join(root, "bin");
  dataDir = join(root, "data");
  log = join(root, "launches.log");
  mkdirSync(bin);
  mkdirSync(dataDir);
  for (const name of ["open", "xdg-open", "glimpseui"]) stub(name);
  recordingBrowser = stub("recording-browser");

  ipcServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      ipcHits.push(new globalThis.URL(req.url).pathname);
      return new Response("ok");
    },
  });
  writeFileSync(join(dataDir, "vscode-ipc.json"), JSON.stringify({ "/": ipcServer.port }));

  childScript = join(root, "child.ts");
  writeFileSync(
    childScript,
    `const [mode, url, remote] = process.argv.slice(2);
const isRemote = remote === "1";
if (mode === "ready") {
  const { handleServerReady } = await import(${JSON.stringify(join(import.meta.dir, "shared-handlers.ts"))});
  await handleServerReady(url, isRemote, 4321);
} else {
  const { openBrowser } = await import(${JSON.stringify(join(import.meta.dir, "browser.ts"))});
  const opened = await openBrowser(url, { isRemote, useGlimpse: true });
  process.stdout.write(JSON.stringify({ opened }));
}
`,
  );
});

afterAll(() => {
  ipcServer?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function run(
  mode: "ready" | "open",
  remote: boolean,
  browserEnv: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  rmSync(log, { force: true });
  ipcHits = [];
  const child = Bun.spawn([process.execPath, childScript, mode, URL, remote ? "1" : "0"], {
    cwd: root,
    env: {
      PATH: bin,
      HOME: root,
      TMPDIR: root,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_REMOTE: remote ? "1" : "0",
      ...browserEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await Bun.sleep(200);
  return { stdout, stderr, exitCode };
}

describe.if(posix)("PLANNOTATOR_BROWSER=none on the Bun runtime", () => { // no-browser-guard: sentinel under test (expected text, nothing is set)
  for (const remote of [false, true]) {
    const where = remote ? "remote" : "local";

    test(`a ${where} session prints the URL and the reason, and launches nothing`, async () => {
      const result = await run("ready", remote, {
        PLANNOTATOR_BROWSER: "none", // no-browser-guard: sentinel under test (PATH holds only stand-ins)
        BROWSER: recordingBrowser,
      });
      expect(result.exitCode).toBe(0);
      expect(launches()).toBe("");
      expect(ipcHits).toEqual([]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`\n  Plannotator session ready: ${URL}\n`);
      expect(result.stderr.split("  Not opening a browser (PLANNOTATOR_BROWSER=none).\n").length - 1).toBe(1); // no-browser-guard: sentinel under test (expected text, nothing is set)
      expect(result.stderr).not.toContain("Could not open a browser");
    }, 30_000);

    test(`openBrowser itself opens nothing for a ${where} caller and says why`, async () => {
      const result = await run("open", remote, {
        PLANNOTATOR_BROWSER: "OFF",
        BROWSER: recordingBrowser,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ opened: false });
      expect(launches()).toBe("");
      expect(ipcHits).toEqual([]);
      expect(result.stderr).toBe("  Not opening a browser (PLANNOTATOR_BROWSER=OFF).\n");
    }, 30_000);
  }

  test("BROWSER=true still launches the default opener locally", async () => {
    const result = await run("open", false, { BROWSER: "true" });
    expect(JSON.parse(result.stdout)).toEqual({ opened: true });
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    expect(launches()).toContain(`${opener} ${URL}\n`);
    expect(launches()).toContain("glimpseui ");
  }, 30_000);

  test("BROWSER=true in a remote session still asks VS Code first", async () => {
    const result = await run("open", true, { BROWSER: "true" });
    expect(JSON.parse(result.stdout)).toEqual({ opened: true });
    expect(ipcHits).toEqual(["/open"]);
    expect(launches()).toBe("");
  }, 30_000);
});
