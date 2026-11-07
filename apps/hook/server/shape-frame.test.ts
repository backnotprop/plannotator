/**
 * `plannotator shape frame`. No real browser runs here: Chrome is found by a stand-in, and run by a
 * stand-in that writes the picture itself (NO_BROWSER rules). What regresses if these fail:
 * - with no Chrome the command fails or hangs instead of one line and exit 0 (the agent stops);
 * - `--at` words (end, a time, beat N) are misread, or a moment past the scene is pictured anyway;
 * - the throwaway server lets the page write (seen, notes) or hold a stream open, binds anywhere but
 *   127.0.0.1, or outlives the command;
 * - a Chrome that hangs holds the agent past the timeout.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShapeStore } from "@plannotator/shared/shape/store";
import type { ShapeBoard } from "@plannotator/core/shape";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { chromeArgs, findChrome, NO_CHROME_LINE, parseShapeFrame, runShapeFrame, type ShapeFrameDeps } from "./shape-frame";

const wasBrowser = process.env.PLANNOTATOR_BROWSER;
process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
afterAll(() => {
  if (wasBrowser === undefined) delete process.env.PLANNOTATOR_BROWSER;
  else process.env.PLANNOTATOR_BROWSER = wasBrowser;
});

const scratch = () => mkdtempSync(join(tmpdir(), "shape-frame-test-"));

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
    expect(r.ok && r.command).toEqual({ id: "shp_1", scene: "lamp", at: { kind: "beat", n: 2 }, phone: true, out: "a.png", project: null });
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
    // Stopped once the command returns.
    expect(await fetch(url.origin).then(() => "up", () => "down")).toBe("down");
  });

  test("a Chrome that fails or hangs: no picture, exit 1, and the board is still saved", async () => {
    const { dataDir, id } = stored();
    const failed = deps(dataDir, { runChrome: async () => ({ failed: "Chrome closed before the picture was taken" }) });
    expect(await runShapeFrame([id], failed.d)).toBe(1);
    expect(failed.err[0]).toBe("Chrome did not save a picture (Chrome closed before the picture was taken); the board is saved.");
  });

  test("a Chrome that hangs past the timeout: no picture, exit 1, the agent is not held", async () => {
    const { dataDir, id } = stored();
    const { d, out, err } = deps(dataDir, { runChrome: async () => "timeout", timeoutMs: 50 });
    expect(await runShapeFrame([id], d)).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("no picture; the board is saved.");
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
});
