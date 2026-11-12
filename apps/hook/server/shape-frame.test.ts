import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createShapeStore } from "@plannotator/shared/shape/store";
import type { ShapeBoard } from "@plannotator/core/shape";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { chromeArgs, defaultRunChrome, findChrome, NO_CHROME_LINE, parseShapeFrame, runShapeFrame, type ShapeFrameDeps } from "./shape-frame";

const wasBrowser = process.env.PLANNOTATOR_BROWSER;
process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
const made: string[] = [];
afterAll(() => {
  if (wasBrowser === undefined) delete process.env.PLANNOTATOR_BROWSER;
  else process.env.PLANNOTATOR_BROWSER = wasBrowser;
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "shape-frame-test-"));
  made.push(dir);
  return dir;
};

function standIn(shebang: string, body: string): string {
  const path = join(scratch(), "chrome");
  writeFileSync(path, `#!${shebang}\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const BOARD: ShapeBoard = {
  title: "The lamp",
  claim: "The ball turns the lamp on.",
  views: {
    picture: { html: "<p>Overview</p>" },
    how: { html: '<div data-scene="lamp"><svg viewBox="0 0 100 50"><path data-part="road" d="M0 25H100"/><circle data-part="ball" r="4"/></svg></div>' },
  },
  scenes: {
    lamp: {
      scene: 1,
      title: "The ball reaches the lamp",
      unit: "ms",
      end: 10,
      beats: [{ at: 0, say: "It sets off." }, { at: 8, say: "It arrives." }],
      tracks: { ball: [{ at: 0, along: "road", p: 0 }, { at: 8, along: "road", p: 1 }] },
    },
  },
};

function stored(board: ShapeBoard = BOARD) {
  const dataDir = scratch();
  const made = createShapeStore({ dataDir }).update({ board, project: { name: "lamp", root: "/work/lamp" }, session: null });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { dataDir, id: made.id };
}

function deps(dataDir: string, over: Partial<ShapeFrameDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: ShapeFrameDeps = {
    dataDir,
    cwd: scratch(),
    env: {},
    pageGzip: () => Bun.gzipSync(new TextEncoder().encode("<!doctype html><title>shape</title>")),
    findChrome: () => "/fake/chrome",
    runChrome: async () => "saved",
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ...over,
  };
  return { d, out, err };
}

describe("shape frame arguments", () => {
  test("--at reads end, a time, and beat N (one word or two)", () => {
    const at = (...argv: string[]) => {
      const r = parseShapeFrame(argv);
      return r.ok ? r.command.at : r.error;
    };
    expect(at("--at", "end")).toEqual({ kind: "end" });
    expect(at("--at", "12.5")).toEqual({ kind: "time", t: 12.5 });
    expect(at("--at", "beat", "3")).toEqual({ kind: "beat", n: 3 });
    expect(at("--at", "beat 3")).toEqual({ kind: "beat", n: 3 });
    expect(at("--at", "beat3")).toEqual({ kind: "beat", n: 3 });
    expect(at()).toBeNull();
    for (const bad of ["soon", "-1", "beat 0", "beat"]) expect(at("--at", bad)).toContain("--at takes");
  });

  test("an id, --scene, --phone and --out are read; an unknown flag or a second id is refused", () => {
    const r = parseShapeFrame(["shp_1", "--scene", "lamp", "--phone", "--out", "a.png", "--at", "beat", "2"]);
    expect(r.ok && r.command).toEqual({ id: "shp_1", view: null, scene: "lamp", at: { kind: "beat", n: 2 }, phone: true, out: "a.png", project: null });
    expect(parseShapeFrame(["--view", "how"])).toMatchObject({ ok: true, command: { view: "how" } });
    expect(parseShapeFrame(["--view", "know"])).toEqual({ ok: false, error: "--view takes picture or how." });
    expect(parseShapeFrame(["--width", "9"])).toEqual({ ok: false, error: "shape frame does not take --width." });
    expect(parseShapeFrame(["a", "b"])).toEqual({ ok: false, error: "shape frame takes one shape id at most." });
    expect(parseShapeFrame(["--at"])).toEqual({ ok: false, error: "--at takes a value." });
  });
});

describe("finding Chrome", () => {
  test("CHROME_PATH wins when it is there; the usual places otherwise; none is null", () => {
    expect(findChrome({ CHROME_PATH: "/opt/c" }, "darwin", (p) => p === "/opt/c")).toBe("/opt/c");
    expect(findChrome({ CHROME_PATH: "/opt/c" }, "darwin", () => false)).toBeNull();
    expect(findChrome({ HOME: "/Users/x" }, "darwin", (p) => p === "/Users/x/Applications/Chromium.app/Contents/MacOS/Chromium")).toBe("/Users/x/Applications/Chromium.app/Contents/MacOS/Chromium");
    expect(findChrome({ PATH: "/usr/bin:/snap/bin" }, "linux", (p) => p === "/snap/bin/chromium")).toBe("/snap/bin/chromium");
    expect(findChrome({ PATH: "/usr/bin", HOME: "/h" }, "linux", () => false)).toBeNull();
  });
});

describe("shape frame", () => {
  test("with no Chrome it says so in one line and exits 0, and runs nothing", async () => {
    const { dataDir, id } = stored();
    let ran = false;
    const { d, out, err } = deps(dataDir, { findChrome: () => null, runChrome: async () => ((ran = true), "saved" as const) });
    expect(await runShapeFrame([id, "--at", "end"], d)).toBe(0);
    expect(out).toEqual([NO_CHROME_LINE]);
    expect(err).toEqual([]);
    expect(ran).toBe(false);
  });

  test("a moment the scene does not have is refused before anything starts", async () => {
    const { dataDir, id } = stored();
    for (const [argv, words] of [
      [["--at", "11"], "--at 11 is past the scene's end (10 ms)."],
      [["--at", "beat", "3"], "--at beat 3: the scene has 2 beats."],
      [["--scene", "nope"], "--scene nope: the board's scenes are lamp."],
    ] as const) {
      const { d, err } = deps(dataDir, { findChrome: () => null });
      expect(await runShapeFrame([id, ...argv], d)).toBe(2);
      expect(err[0]).toBe(words);
    }
  });

  test("Chrome opens the scene's view at the moment, on a read-only 127.0.0.1 server that stops afterwards", async () => {
    const { dataDir, id } = stored();
    const outFile = join(scratch(), "lamp.png");
    let seen: { url: string; profile: string; seen: number; events: number; read: number } | null = null;
    const { d, out } = deps(dataDir, {
      runChrome: async (path, shot) => {
        const url = shot.url;
        const base = new URL(url).origin;
        seen = {
          url,
          profile: shot.profile,
          seen: (await fetch(`${base}/api/shapes/${id}/seen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 1 }) })).status,
          events: (await fetch(`${base}/api/shapes/events`)).status,
          read: (await fetch(`${base}/api/shapes/${id}`)).status,
        };
        expect(path).toBe("/fake/chrome");
        writeFileSync(shot.out, "png");
        return "saved";
      },
    });
    expect(await runShapeFrame([id, "--at", "beat", "2", "--out", outFile], d)).toBe(0);
    expect(out).toEqual([outFile]);
    const s = seen!;
    const url = new URL(s.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).not.toBe("59812");
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({ shape: id, view: "how", frame: "lamp", at: "8" });
    expect([s.seen, s.events, s.read]).toEqual([405, 404, 200]);
    expect(s.profile.startsWith(tmpdir())).toBe(true);
    expect(chromeArgs({ profile: s.profile, phone: false })).toEqual(expect.arrayContaining(["--headless=new", `--user-data-dir=${s.profile}`, "--remote-debugging-pipe"]));
    expect(chromeArgs({ profile: s.profile, phone: false }).some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
    expect(await fetch(url.origin).then(() => "up", () => "down")).toBe("down");
    expect(existsSync(s.profile)).toBe(false);
  });

  test("by default the picture goes in a new folder of this run's own, closed to other users", async () => {
    const { dataDir, id } = stored();
    const outs: string[] = [];
    const { d, out } = deps(dataDir, {
      runChrome: async (_p, shot) => {
        outs.push(shot.out);
        writeFileSync(shot.out, "png");
        return "saved";
      },
    });
    expect(await runShapeFrame([id], d)).toBe(0);
    expect(await runShapeFrame([id], d)).toBe(0);
    made.push(...outs.map((o) => dirname(o)));
    expect(out).toEqual(outs);
    const [a, b] = outs.map((o) => dirname(o));
    expect(a).not.toBe(b);
    for (const dir of [a!, b!]) {
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(outs[0]!.endsWith(`${id}-lamp-end.png`)).toBe(true);
  });

  test("a Chrome that fails: no picture, exit 1, the board is still saved, and nothing is left in temp", async () => {
    const { dataDir, id } = stored();
    let shot: { out: string; profile: string } | null = null;
    const failed = deps(dataDir, { runChrome: async (_p, s) => ((shot = s), { failed: "Chrome closed before the picture was taken" }) });
    expect(await runShapeFrame([id], failed.d)).toBe(1);
    expect(failed.err[0]).toBe("Chrome did not save a picture (Chrome closed before the picture was taken); the board is saved.");
    expect(existsSync(shot!.profile)).toBe(false);
    expect(existsSync(dirname(shot!.out))).toBe(false);
  });

  test("a Chrome that hangs is killed at the timeout (the real runner, a stand-in that sleeps): exit 1, the agent is not held", async () => {
    const { dataDir, id } = stored();
    const chrome = standIn("/bin/sh", 'echo $$ > "$(dirname "$0")/pid"\nexec sleep 30\n');
    const { d, out, err } = deps(dataDir, { findChrome: () => chrome, runChrome: undefined, timeoutMs: 300 });
    const started = Date.now();
    expect(await runShapeFrame([id, "--at", "end"], d)).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toEqual([]);
    expect(err[0]).toContain("Chrome took longer than");
    expect(err[0]).toContain("so no picture; the board is saved.");
    const pid = Number(readFileSync(join(dirname(chrome), "pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(await gone(pid)).toBe(true);
  });

  test("a Chrome that quits right after sending the picture: saved (0600), not a failure", async () => {
    const chrome = standIn(
      process.execPath,
      `const fs = require("fs");
let buf = "";
const say = (m) => fs.writeSync(4, JSON.stringify(m) + "\\0");
fs.createReadStream("", { fd: 3 }).on("data", (c) => {
  buf += c;
  const parts = buf.split("\\0");
  buf = parts.pop();
  for (const p of parts) {
    const m = JSON.parse(p);
    if (m.method === "Page.captureScreenshot") { say({ id: m.id, result: { data: Buffer.from("png").toString("base64") } }); process.exit(0); }
    const result = m.method === "Target.createTarget" ? { targetId: "t" } : m.method === "Target.attachToTarget" ? { sessionId: "s" } : m.method === "Runtime.evaluate" ? { result: { value: true } } : {};
    say({ id: m.id, result });
  }
});
`,
    );
    const dir = scratch();
    const shot = { url: "http://127.0.0.1:9/#shape=x", out: join(dir, "p.png"), profile: join(dir, "profile"), phone: false };
    expect(await defaultRunChrome(chrome, shot, 10_000)).toBe("saved");
    expect(readFileSync(shot.out, "utf8")).toBe("png");
    expect(statSync(shot.out).mode & 0o777).toBe(0o600);
  });

  test("a still board is pictured as it stands; --at says it changes nothing", async () => {
    const still: ShapeBoard = { title: "Still", claim: "A still board.", views: { picture: { html: "<p>x</p>" } } };
    const { dataDir, id } = stored(still);
    let hash = "";
    const { d, err } = deps(dataDir, {
      runChrome: async (_p, shot) => {
        hash = new URL(shot.url).hash;
        writeFileSync(shot.out, "png");
        return "saved";
      },
    });
    expect(await runShapeFrame([id, "--at", "end", "--out", join(scratch(), "s.png")], d)).toBe(0);
    expect(hash).toBe(`#shape=${id}`);
    expect(err[0]).toContain("This board does not move");
  });

  test("--view how pictures How it works; on a board that moves, the view's own scene, or the view as it stands", async () => {
    const { dataDir, id } = stored();
    const hashes: string[] = [];
    const { d } = deps(dataDir, {
      runChrome: async (_p, shot) => {
        hashes.push(new URL(shot.url).hash);
        writeFileSync(shot.out, "png");
        return "saved";
      },
    });
    expect(await runShapeFrame([id, "--view", "how", "--out", join(scratch(), "h.png")], d)).toBe(0);
    expect(await runShapeFrame([id, "--view", "picture", "--out", join(scratch(), "p.png")], d)).toBe(0);
    expect(hashes).toEqual([`#shape=${id}&view=how&frame=lamp&at=10`, `#shape=${id}`]);
    const wrong = deps(dataDir);
    expect(await runShapeFrame([id, "--view", "picture", "--scene", "lamp"], wrong.d)).toBe(2);
    expect(wrong.err[0]).toBe("--scene lamp plays in How it works, not --view picture.");
  });
});
