/**
 * `plannotator shape open` (shape-open.ts): the Shape page without the Inbox.
 *
 * What regresses:
 *  - it starts a server or opens a page while Shape is off (the switch must
 *    print only `shape_off`, as for every `plannotator shape …`);
 *  - a second `open` starts a second server instead of reusing the running one;
 *  - a stale `server.json` (its process gone) is taken as running;
 *  - an unknown board id opens a page that shows nothing;
 *  - the address it prints and opens is not the board's (`#shape=<id>`);
 *  - bare `plannotator shape` opens a second tab while a Shape page is already
 *    open, or opens none when it cannot tell (an older server).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShapeStore } from "@plannotator/shared/shape/store";
import { isProcessAlive, readShapeServerEntry, runningShapeServer, SHAPE_SERVER_INFO_PATH, shapeServerPath, startShapeServer, type ShapeServer } from "@plannotator/server/shape";
import { SHAPE_EVENTS_PATH } from "@plannotator/shared/shape/routes";
import { parseShapeOpen, runShapeOpen, shapePageUrl } from "./shape-open";

const roots: string[] = [];
const servers: ShapeServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const board = { title: "Kettle", claim: "Built.", views: { picture: { html: "<p>One whistle</p>" } } };

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shape-open-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const project = join(root, "kettle");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const made = createShapeStore({ dataDir }).update({ board, project: { root: project, name: "kettle" }, session: null });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { root, dataDir, project, id: made.id };
}

test("parse: one id at most, --json, nothing else", () => {
  expect(parseShapeOpen([])).toEqual({ ok: true, id: null, json: false });
  expect(parseShapeOpen(["shp_1", "--json"])).toEqual({ ok: true, id: "shp_1", json: true });
  expect(parseShapeOpen(["a", "b"]).ok).toBe(false);
  expect(parseShapeOpen(["--thread", "x"]).ok).toBe(false);
  expect(shapePageUrl("http://127.0.0.1:5", null)).toBe("http://127.0.0.1:5/");
  expect(shapePageUrl("http://127.0.0.1:5", "shp_1")).toBe("http://127.0.0.1:5/#shape=shp_1");
});

describe("runShapeOpen", () => {
  test("an unknown board: not_found, and no server is started", async () => {
    const w = world();
    let spawned = 0;
    const err: string[] = [];
    const code = await runShapeOpen(["shp_01JZZZZZZZZZZZZZZZZZZZZZZZ"], { dataDir: w.dataDir, openUrl: async () => "opened", spawnServer: () => spawned++, stderr: (t) => err.push(t), stdout: () => {} });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not_found: No shape shp_01JZZZZZZZZZZZZZZZZZZZZZZZ.");
    expect(spawned).toBe(0);
  });

  test("starts the server once, then reuses it; opens and prints the board's address", async () => {
    const w = world();
    let spawned = 0;
    const opened: string[] = [];
    const out: string[] = [];
    const deps = {
      dataDir: w.dataDir,
      openUrl: async (url: string) => {
        opened.push(url);
        return "opened" as const;
      },
      // Stands in for the detached `plannotator shape serve`: the same server, in this process.
      spawnServer: (dataDir: string) => {
        spawned++;
        void startShapeServer({ dataDir, shape: true }).then((s) => servers.push(s));
      },
      stdout: (t: string) => out.push(t),
      stderr: () => {},
    };
    expect(await runShapeOpen([w.id], deps)).toBe(0);
    const port = readShapeServerEntry(w.dataDir)!.port;
    expect(out).toEqual([`http://127.0.0.1:${port}/#shape=${w.id}`]);
    expect(opened).toEqual(out);
    expect(await runShapeOpen(["--json"], deps)).toBe(0);
    expect(JSON.parse(out[1]!)).toEqual({ url: `http://127.0.0.1:${port}/`, opened: true });
    expect(spawned).toBe(1);
  });

  test("a stale server.json (its process gone) is replaced, not reused", async () => {
    const w = world();
    mkdirSync(join(w.dataDir, "shapes"), { recursive: true });
    writeFileSync(shapeServerPath(w.dataDir), JSON.stringify({ v: 1, pid: 2 ** 22 + 4321, port: 1, url: "http://127.0.0.1:1", version: "old", started: "" }));
    let spawned = 0;
    const code = await runShapeOpen([], {
      dataDir: w.dataDir,
      openUrl: async () => "opened",
      spawnServer: (dataDir) => {
        spawned++;
        void startShapeServer({ dataDir, shape: true, port: 0 }).then((s) => servers.push(s));
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(spawned).toBe(1);
    expect(readShapeServerEntry(w.dataDir)!.pid).toBe(process.pid);
  });
});

/** A page holding the event stream open, as the Shape page does; close() drops it and waits until the server saw it. */
async function connectPage(dataDir: string, entry: { url: string }) {
  const controller = new AbortController();
  const response = await fetch(`${entry.url}${SHAPE_EVENTS_PATH}`, { signal: controller.signal });
  expect(response.status).toBe(200);
  return {
    close: async () => {
      controller.abort();
      for (let i = 0; i < 50 && (await runningShapeServer(dataDir))?.pages !== 0; i++) await Bun.sleep(20);
      expect((await runningShapeServer(dataDir))?.pages).toBe(0);
    },
  };
}

describe("bare `plannotator shape`: the page already open, if there is one", () => {
  /** A running Shapes server in this process, and a spy for openUrl that opens nothing. */
  async function running() {
    const w = world();
    const server = await startShapeServer({ dataDir: w.dataDir, shape: true, port: 0 });
    servers.push(server);
    const entry = readShapeServerEntry(w.dataDir)!;
    const opened: string[] = [];
    const out: string[] = [];
    const deps = {
      dataDir: w.dataDir,
      openUrl: async (url: string) => {
        opened.push(url);
        return "opened" as const;
      },
      spawnServer: () => {
        throw new Error("the running server must be reused");
      },
      stdout: (t: string) => out.push(t),
      stderr: () => {},
    };
    return { w, entry, opened, out, deps };
  }

  const pagesOf = async (dataDir: string) => (await runningShapeServer(dataDir))?.pages;

  test("a page is open: it prints the address and opens no tab; `shape open` still opens one", async () => {
    const r = await running();
    const page = await connectPage(r.w.dataDir, r.entry);
    try {
      expect(await pagesOf(r.w.dataDir)).toBe(1);
      expect(await runShapeOpen([], { ...r.deps, reuseOpenPage: true })).toBe(0);
      expect(r.out).toEqual([`${r.entry.url}/`]);
      expect(r.opened).toEqual([]);
      expect(await runShapeOpen([], r.deps)).toBe(0);
      expect(r.opened).toEqual([`${r.entry.url}/`]);
    } finally {
      await page.close();
    }
  });

  test("no page is open: it opens one", async () => {
    const r = await running();
    // One that came and went counts for nothing.
    await (await connectPage(r.w.dataDir, r.entry)).close();
    expect(await runShapeOpen([], { ...r.deps, reuseOpenPage: true })).toBe(0);
    expect(r.opened).toEqual([`${r.entry.url}/`]);
    expect(r.out).toEqual(r.opened);
  });

  test("an older server that does not report its pages: it opens one", async () => {
    const w = world();
    // A Shapes server from before the field: it answers who it is, but not how many pages it has.
    const old = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === SHAPE_SERVER_INFO_PATH ? Response.json({ shape_server: 1, version: "old", serverSession: "s", on: true }) : new Response("", { status: 404 }),
    });
    try {
      mkdirSync(join(w.dataDir, "shapes"), { recursive: true });
      const url = `http://127.0.0.1:${old.port}`;
      writeFileSync(shapeServerPath(w.dataDir), JSON.stringify({ v: 1, pid: process.pid, port: old.port, url, version: "old", started: "" }));
      expect(await pagesOf(w.dataDir)).toBeNull();
      const opened: string[] = [];
      const code = await runShapeOpen([], {
        dataDir: w.dataDir,
        openUrl: async (u) => {
          opened.push(u);
          return "opened";
        },
        spawnServer: () => {
          throw new Error("the running server must be reused");
        },
        stdout: () => {},
        stderr: () => {},
        reuseOpenPage: true,
      });
      expect(code).toBe(0);
      expect(opened).toEqual([`${url}/`]);
    } finally {
      old.stop(true);
    }
  });
});

describe("through the entrypoint", () => {
  // The real CLI from source: the switch gate in index.ts, the detached `shape serve`, the reuse. The server it
  // starts is this test's own process (its pid is in the sandbox's server.json), and it is stopped at the end.
  test("off: shape_off and no server; on: one detached server, reused, serving the page and the boards", async () => {
    const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
    const { NO_BROWSER } = await import("../../../tests/helpers/no-browser");
    const { SHAPE_OFF_TEXT } = await import("./shape-command");
    const w = world();
    const stubbed = stubHookDistHtml();
    const entry = join(import.meta.dir, "index.ts");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME!,
      PLANNOTATOR_DATA_DIR: w.dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER: "1",
      NO_ANON_PING: "1",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_INBOX_NOTES: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
    };
    const run = async (...argv: string[]) => runWith(env, ...argv);
    const runWith = async (withEnv: Record<string, string>, ...argv: string[]) => {
      const proc = Bun.spawn(["bun", "run", entry, "shape", ...argv], { cwd: w.project, env: withEnv, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    let serverPid: number | null = null;
    try {
      // Bare `plannotator shape` (it opens the page) is gated like `open`.
      for (const argv of [[], ["open"], ["open", w.id], ["serve"]]) {
        const r = await run(...argv);
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe(`${SHAPE_OFF_TEXT}\n`);
      }
      expect(readShapeServerEntry(w.dataDir)).toBeNull();

      writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxShape: true }));
      const first = await run("open", w.id);
      expect(first.code, first.stderr).toBe(0);
      const started = readShapeServerEntry(w.dataDir)!;
      serverPid = started.pid;
      expect(serverPid).not.toBe(process.pid);
      expect(first.stdout.trim()).toBe(`http://127.0.0.1:${started.port}/#shape=${w.id}`);
      const again = await run("open");
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout.trim()).toBe(`http://127.0.0.1:${started.port}/`);
      expect(readShapeServerEntry(w.dataDir)!.pid).toBe(serverPid);
      expect((await fetch(`http://127.0.0.1:${started.port}/`)).status).toBe(200);
      const list = (await (await fetch(`http://127.0.0.1:${started.port}/api/shapes`)).json()) as { shapes: { id: string }[] };
      expect(list.shapes.map((s) => s.id)).toEqual([w.id]);
      const help = await run("open", "--help");
      expect(`${help.stdout}${help.stderr}`).toContain("plannotator shape open [<shp_id>]");
      // Bare `plannotator shape` opens the page like `open` with no id (the browser is the no-browser sandbox's),
      // prints its address and reuses the server; the usage moved to --help, which opens nothing.
      const bare = await run();
      expect(bare.code, bare.stderr).toBe(0);
      expect(bare.stdout).toBe(`http://127.0.0.1:${started.port}/\n`);
      expect(bare.stderr).not.toContain("Usage:");
      expect(readShapeServerEntry(w.dataDir)!.pid).toBe(serverPid);
      const { SHAPE_COMMAND_USAGE } = await import("./shape-command");
      const shapeHelp = await run("--help");
      expect(shapeHelp.code).toBe(0);
      expect(`${shapeHelp.stdout}${shapeHelp.stderr}`.trim()).toBe(SHAPE_COMMAND_USAGE);

      // The wiring in index.ts: with a page open, bare `plannotator shape` opens no tab, and `shape open` still
      // does. A stand-in browser (it opens nothing) writes each address it is handed to a file.
      const marker = join(w.root, "browser-opened");
      const browser = join(w.root, "fake-browser.sh");
      writeFileSync(browser, `#!/bin/sh\necho "$1" >> '${marker}'\n`);
      chmodSync(browser, 0o755);
      const recording = { ...env, PLANNOTATOR_BROWSER: browser, BROWSER: browser };
      const page = await connectPage(w.dataDir, { url: `http://127.0.0.1:${started.port}` });
      try {
        expect((await runningShapeServer(w.dataDir))?.pages).toBe(1);
        const bareOpen = await runWith(recording);
        expect(bareOpen.code, bareOpen.stderr).toBe(0);
        expect(bareOpen.stdout).toBe(`http://127.0.0.1:${started.port}/\n`);
        const named = await runWith(recording, "open");
        expect(named.code, named.stderr).toBe(0);
        // The browser is started detached: wait for `open`'s address, then a little longer for a stray one from bare.
        for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(30);
        await Bun.sleep(300);
        expect(readFileSync(marker, "utf8")).toBe(`http://127.0.0.1:${started.port}/\n`);
      } finally {
        await page.close();
      }
    } finally {
      if (serverPid && isProcessAlive(serverPid)) {
        process.kill(serverPid, "SIGTERM");
        for (let i = 0; i < 50 && isProcessAlive(serverPid); i++) await Bun.sleep(50);
      }
      removeStubbedHtml(stubbed);
    }
    expect(readFileSync(join(w.dataDir, "shapes", "server.log"), "utf8")).toContain("Plannotator Shape:");
  }, 60_000);
});
