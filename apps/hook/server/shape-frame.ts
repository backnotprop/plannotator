/**
 * `plannotator shape frame [<shp_id>] [--view picture|how] [--scene <id>] [--at <time|end|beat N>] [--phone] [--out <file.png>]`
 * (approval "shape-animated-scenes", addendum): a picture of a board as the person sees it, so an agent
 * that cannot watch its scene can still look at it. On a board that moves, `--at` picks the moment
 * (default: the scene's end); a still board is pictured as it stands.
 *
 * How: a throwaway Shapes server in this process, on 127.0.0.1 and a free port, read-only (no write,
 * no event stream: `readOnly`), never registered in `server.json`, so the person's own Shape page and
 * Inbox are never touched. The Chrome already on this computer (never a download) opens the real Shape
 * page there, headless, with `#shape=<id>&frame=<scene>&at=<t>` (the page draws that scene still at that
 * moment: `@plannotator/ui/components/shape/scene/frame`), and saves its window as a PNG (0600; by default
 * in a new folder of its own in the OS temp dir, 0700, so no other user can read or plant it). Its
 * profile is a new folder in the OS temp dir, removed once Chrome is gone. After `FRAME_TIMEOUT_MS` the
 * Chrome this started (its own pid, nothing else) is killed, so the command can never hang an agent.
 *
 * With no Chrome it says so in one line and exits 0: the board is saved, and the agent carries on.
 * Like every `plannotator shape …`, it runs only while Shape is on (index.ts).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { shapeHtmlScenes, type ShapeScene } from "@plannotator/core/shape-scene";
import type { ShapeVersion } from "@plannotator/core/shape";
import { createShapeStore } from "@plannotator/shared/shape/store";
import { resolveInboxProjectRoot } from "@plannotator/server/inbox-project-root";
import { startShapeServer } from "@plannotator/server/shape";
import { inboxHostSessionFromEnv } from "./inbox-mcp-shim";

export const FRAME_TIMEOUT_MS = 20_000;
export const NO_CHROME_LINE = "No Chrome found, so no picture; the board is saved.";

/** A moment of a scene, as `--at` names it. */
export type FrameMoment = { kind: "end" } | { kind: "time"; t: number } | { kind: "beat"; n: number };

export interface ParsedShapeFrame {
  id: string | null;
  /** The view to picture (default: the scene's, else the Picture). */
  view: "picture" | "how" | null;
  scene: string | null;
  at: FrameMoment | null;
  phone: boolean;
  out: string | null;
  project: string | null;
}

const VALUE_FLAGS = new Set(["--view", "--scene", "--at", "--out", "--project"]);

/** `--at` words: `end`, a time in the scene's own clock (`12.5`), or `beat 3` / `beat3` (counting from 1). */
export function parseFrameMoment(text: string): FrameMoment | null {
  const v = text.trim().toLowerCase();
  if (v === "end") return { kind: "end" };
  const beat = /^beat\s*(\d+)$/.exec(v);
  if (beat) return Number(beat[1]) >= 1 ? { kind: "beat", n: Number(beat[1]) } : null;
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  return { kind: "time", t: Number(v) };
}

export function parseShapeFrame(argv: readonly string[]): { ok: true; command: ParsedShapeFrame } | { ok: false; error: string } {
  const out: ParsedShapeFrame = { id: null, view: null, scene: null, at: null, phone: false, out: null, project: null };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--phone") {
      out.phone = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) return { ok: false, error: `shape frame does not take ${arg}.` };
    let value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} takes a value.` };
    i++;
    // `--at beat 3`: the beat's number is its own word.
    if (arg === "--at" && value.trim().toLowerCase() === "beat" && argv[i + 1] !== undefined && /^\d+$/.test(argv[i + 1]!)) value = `beat ${argv[++i]}`;
    if (arg === "--at") {
      const at = parseFrameMoment(value);
      if (!at) return { ok: false, error: "--at takes a time in the scene's clock (12.5), end, or beat N (counting from 1)." };
      out.at = at;
    } else if (arg === "--view") {
      if (value !== "picture" && value !== "how") return { ok: false, error: "--view takes picture or how." };
      out.view = value;
    } else if (arg === "--scene") out.scene = value;
    else if (arg === "--out") out.out = value;
    else if (arg === "--project") out.project = value;
  }
  if (positional.length > 1) return { ok: false, error: "shape frame takes one shape id at most." };
  out.id = positional[0] ?? null;
  return { ok: true, command: out };
}

/** The view a scene plays in: the first drawn view whose drawing has its slot. */
function viewOf(version: ShapeVersion, scene: string): "picture" | "how" | null {
  for (const v of ["picture", "how"] as const) {
    const view = version.views[v];
    if (!view) continue;
    if ([view.html, view.tall?.html ?? "", view.more?.html ?? ""].some((html) => shapeHtmlScenes(html).includes(scene))) return v;
  }
  return null;
}

/** The scene's time for a moment, or why it has none. */
export function frameTime(scene: ShapeScene, at: FrameMoment): { ok: true; t: number } | { ok: false; error: string } {
  if (at.kind === "end") return { ok: true, t: scene.end };
  if (at.kind === "beat") {
    if (at.n > scene.beats.length) return { ok: false, error: `--at beat ${at.n}: the scene has ${scene.beats.length} beat${scene.beats.length === 1 ? "" : "s"}.` };
    return { ok: true, t: scene.beats[at.n - 1]!.at };
  }
  if (at.t > scene.end) return { ok: false, error: `--at ${at.t} is past the scene's end (${scene.end}${scene.unit && scene.unit !== "step" ? ` ${scene.unit}` : ""}).` };
  return { ok: true, t: at.t };
}

export interface FramePlan {
  id: string;
  /** The page's hash: the board, its view, and (on a board that moves) the scene and its moment. */
  hash: string;
  /** Words for the file name: `pool-end`, `pool-beat3`, `picture`. */
  label: string;
}

/** What to picture: the board's scene (or its Picture) at the moment asked for. */
export function planFrame(version: ShapeVersion, id: string, c: Pick<ParsedShapeFrame, "view" | "scene" | "at">): { ok: true; plan: FramePlan; note?: string } | { ok: false; error: string } {
  const scenes = version.scenes ?? {};
  const ids = Object.keys(scenes);
  const hash = new URLSearchParams({ shape: id });
  if (c.view && !version.views[c.view]) return { ok: false, error: `--view ${c.view}: this board has no ${c.view === "how" ? "How it works" : "Picture"}.` };
  // The scene asked for, else the first one the view asked for plays, else (no view asked) the first one a drawing plays.
  const inView = c.view ? ids.find((s) => viewOf(version, s) === c.view) : ids.find((s) => viewOf(version, s) === "picture") ?? ids.find((s) => viewOf(version, s));
  if (!c.scene && !inView) {
    if (c.scene === null && ids.length && !c.view) return { ok: false, error: "no drawing on the board plays its scenes (no <div data-scene=\"…\">)." };
    const view = c.view ?? (!version.views.picture && version.views.how ? "how" : "picture");
    if (view === "how") hash.set("view", "how");
    return { ok: true, plan: { id, hash: `#${hash}`, label: view }, ...(c.at ? { note: `This ${c.view ? "view" : "board"} does not move, so --at changes nothing: the picture is the ${c.view ? "view" : "board"} as it stands.` } : {}) };
  }
  const scene = c.scene ?? inView!;
  if (!Object.hasOwn(scenes, scene)) return { ok: false, error: `--scene ${scene}: the board's scenes are ${ids.join(", ")}.` };
  const view = viewOf(version, scene);
  if (!view) return { ok: false, error: `--scene ${scene}: no drawing on the board plays it (no <div data-scene="${scene}">).` };
  if (c.view && c.view !== view) return { ok: false, error: `--scene ${scene} plays in ${view === "how" ? "How it works" : "the Picture"}, not --view ${c.view}.` };
  const at = c.at ?? { kind: "end" as const };
  const time = frameTime(scenes[scene]!, at);
  if (!time.ok) return time;
  if (view === "how") hash.set("view", "how");
  hash.set("frame", scene);
  hash.set("at", String(time.t));
  const label = `${scene}-${at.kind === "end" ? "end" : at.kind === "beat" ? `beat${at.n}` : `t${String(at.t).replace(".", "_")}`}`;
  return { ok: true, plan: { id, hash: `#${hash}`, label } };
}

/** The Chrome (or Chromium, Edge, Brave) already on this computer; null when there is none. Never a download. */
export function findChrome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string | null {
  const named = env.CHROME_PATH?.trim();
  if (named) return exists(named) ? named : null;
  const candidates: string[] = [];
  if (platform === "darwin") {
    const apps = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium", "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Brave Browser.app/Contents/MacOS/Brave Browser"];
    for (const dir of ["/Applications", ...(env.HOME ? [join(env.HOME, "Applications")] : [])]) for (const app of apps) candidates.push(join(dir, app));
  } else if (platform === "win32") {
    const exes = ["Google\\Chrome\\Application\\chrome.exe", "Chromium\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) if (base) for (const exe of exes) candidates.push(`${base}\\${exe}`);
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) for (const name of names) candidates.push(join(dir, name));
  }
  return candidates.find((p) => exists(p)) ?? null;
}

/** The window a picture is taken in: a laptop's, or a phone's (`--phone`), at 2x. */
export function frameWindow(phone: boolean): { width: number; height: number; scale: number } {
  return phone ? { width: 390, height: 844, scale: 2 } : { width: 1440, height: 900, scale: 2 };
}

/**
 * Chrome's arguments: headless, a fresh profile, nothing synced or fetched beyond the page, and the
 * DevTools protocol over a pipe (fds 3 and 4), so no debugging port is opened.
 */
export function chromeArgs(o: { profile: string; phone: boolean }): string[] {
  const w = frameWindow(o.phone);
  return [
    "--headless=new",
    `--user-data-dir=${o.profile}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--metrics-recording-only",
    "--no-pings",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-gpu",
    // macOS: a fresh profile would ask the keychain for its storage key, and wait on that forever.
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${w.width},${w.height}`,
    "about:blank",
  ];
}

export interface FrameShot {
  url: string;
  /** Where the PNG goes. */
  out: string;
  profile: string;
  phone: boolean;
}

export interface ShapeFrameDeps {
  dataDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** The built Shape page, gzipped (the binary's own). */
  pageGzip: () => Uint8Array;
  version?: string;
  /** Finds Chrome (tests pass a stand-in; never a real browser in tests). */
  findChrome?: () => string | null;
  /**
   * Takes the picture with the Chrome at `path` (tests pass a stand-in). Resolves "saved" once the PNG
   * is written, "timeout" once Chrome has been killed after `timeoutMs`, or why it failed.
   */
  runChrome?: (path: string, shot: FrameShot, timeoutMs: number) => Promise<"saved" | "timeout" | { failed: string }>;
  timeoutMs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Once the board is drawn, how long to let it settle (its entrance, and the player's second measure at 1.4 s). */
const SETTLE_MS = 2000;

/**
 * Open the page in headless Chrome and save its window as a PNG, through the DevTools protocol on a
 * pipe: set the window, go to the page, wait until the board is drawn and has settled, take the
 * picture, close. Past `timeoutMs`, or when done, it kills the Chrome it started (its own pid only).
 */
export function defaultRunChrome(path: string, shot: FrameShot, timeoutMs: number): Promise<"saved" | "timeout" | { failed: string }> {
  return new Promise((done) => {
    let finished = false;
    const child = nodeSpawn(path, chromeArgs(shot), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const toChrome = child.stdio[3] as NodeJS.WritableStream | null;
    const fromChrome = child.stdio[4] as NodeJS.ReadableStream | null;
    const kill = () => {
      try {
        if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const finish = (result: "saved" | "timeout" | { failed: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      kill();
      done(result);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    child.on("error", (e) => finish({ failed: e.message }));
    // "close", not "exit": everything Chrome wrote to the pipe is read first, so a picture sent just before it quit still counts.
    child.on("close", () => finish({ failed: "Chrome closed before the picture was taken" }));
    if (!toChrome || !fromChrome) return finish({ failed: "no pipe to Chrome" });
    // A write or read after Chrome is gone (killed, or closed on its own) is not an error worth a crash.
    toChrome.on("error", () => finish({ failed: "Chrome closed before the picture was taken" }));
    fromChrome.on("error", () => finish({ failed: "Chrome closed before the picture was taken" }));

    let next = 0;
    const waiting = new Map<number, (msg: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((ok, bad) => {
        const id = ++next;
        waiting.set(id, (msg) => (msg.error ? bad(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result ?? {})));
        toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      });
    let buffer = "";
    fromChrome.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\0");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        try {
          const msg = JSON.parse(part) as { id?: number };
          if (msg.id !== undefined) waiting.get(msg.id)?.(msg as never);
          if (msg.id !== undefined) waiting.delete(msg.id);
        } catch {
          // not ours
        }
      }
    });
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    void (async () => {
      const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      const w = frameWindow(shot.phone);
      await send("Emulation.setDeviceMetricsOverride", { width: w.width, height: w.height, deviceScaleFactor: w.scale, mobile: shot.phone }, sessionId);
      await send("Page.enable", {}, sessionId);
      await send("Page.navigate", { url: shot.url }, sessionId);
      // Drawn: the board's view (or the page saying it could not open it).
      for (;;) {
        const r = (await send("Runtime.evaluate", { expression: "!!document.querySelector('.shp-view .shp-drawn, .shp-view, .shp-failed')", returnByValue: true }, sessionId)) as { result?: { value?: unknown } };
        if (r.result?.value === true) break;
        await pause(150);
      }
      await pause(SETTLE_MS);
      const { data } = (await send("Page.captureScreenshot", { format: "png" }, sessionId)) as { data: string };
      writeFileSync(shot.out, Buffer.from(data, "base64"), { mode: 0o600 });
      // Saved: done now. `finish` kills Chrome, so there is no waiting on a reply it may never send.
      finish("saved");
    })().catch((e: unknown) => finish({ failed: e instanceof Error ? e.message : String(e) }));
  });
}

export async function runShapeFrame(argv: readonly string[], deps: ShapeFrameDeps): Promise<number> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const parsed = parseShapeFrame(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\nUsage: plannotator shape frame [<shp_id>] [--view picture|how] [--scene <id>] [--at <time|end|beat N>] [--phone] [--out <file.png>]`);
    return 2;
  }
  const c = parsed.command;
  const store = createShapeStore({ dataDir: deps.dataDir });
  let id = c.id;
  if (!id) {
    const host = inboxHostSessionFromEnv(deps.env);
    const folder = c.project ? (isAbsolute(c.project) ? c.project : resolve(deps.cwd, c.project)) : deps.cwd;
    const root = await resolveInboxProjectRoot(folder).then((r) => r.root).catch(() => null);
    id = store.latestFor({ session: host ? { host: host.host, id: host.session } : null, root })?.id ?? null;
    if (!id) {
      err("not_found: no shape here yet. Name one: plannotator shape frame <shp_id>.");
      return 1;
    }
  }
  const version = store.read(id);
  if (!version) {
    err(`not_found: no shape ${id}.`);
    return 1;
  }
  const planned = planFrame(version, id, c);
  if (!planned.ok) {
    err(planned.error);
    return 2;
  }
  if (planned.note) err(planned.note);

  const chrome = (deps.findChrome ?? (() => findChrome(deps.env)))();
  if (!chrome) {
    out(NO_CHROME_LINE);
    return 0;
  }

  // The picture: where --out says, or a new folder of this run's own (mkdtemp: 0700, never a shared one).
  const ownDir = c.out ? null : mkdtempSync(join(tmpdir(), "plannotator-shape-frame-"));
  const file = c.out ? (isAbsolute(c.out) ? c.out : resolve(deps.cwd, c.out)) : join(ownDir!, `${id}-${planned.plan.label}${c.phone ? "-phone" : ""}.png`);
  const profile = mkdtempSync(join(tmpdir(), "plannotator-frame-chrome-"));
  let saved = false;
  const server = await startShapeServer({ dataDir: deps.dataDir, pageGzip: deps.pageGzip, shape: true, port: 0, register: false, readOnly: true, version: deps.version, idleMs: 60 * 60_000 });
  try {
    const url = `${server.url}/${planned.plan.hash}`;
    const timeoutMs = deps.timeoutMs ?? FRAME_TIMEOUT_MS;
    const result = await (deps.runChrome ?? defaultRunChrome)(chrome, { url, out: file, profile, phone: c.phone }, timeoutMs);
    if (result === "timeout") {
      err(`Chrome took longer than ${Math.round(timeoutMs / 1000)} s, so no picture; the board is saved.`);
      return 1;
    }
    let made = false;
    try {
      made = statSync(file).size > 0;
    } catch {
      made = false;
    }
    if (result !== "saved" || !made) {
      err(`Chrome did not save a picture${result !== "saved" ? ` (${result.failed})` : ""}; the board is saved.`);
      return 1;
    }
    saved = true;
    out(file);
    return 0;
  } finally {
    server.stop();
    // Chrome is gone by now (runChrome kills it before it resolves): its profile goes too, and the
    // run's own picture folder when no picture was saved in it.
    for (const dir of [profile, ...(ownDir && !saved ? [ownDir] : [])]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // left for the OS to clear
      }
    }
  }
}
