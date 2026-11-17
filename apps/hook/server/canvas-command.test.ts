/**
 * `plannotator canvas …` in process: what an agent sees from each command. Every run gets its own data dir and
 * folder under the OS temp folder; nothing here reads the person's data, environment or Inbox, and no window lays
 * anything out (a test plays the window by finishing the layout itself). What regresses if these fail:
 * - off, the command leaks: `plannotator --help` lists it, or the unknown-command answer names it;
 * - the switch turns on for anything but `inboxCanvas: true`;
 * - a write to a thread that does not exist is stored, or one to a real thread is not;
 * - a patch is not applied to the stored board, or a bad one changes it;
 * - the agent waits for a window that is not open, or does not get the layout's warnings from one that is;
 * - `read` does not tell the agent what the person did, what is pinned and what is deleted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_HELP_TEXT } from "@plannotator/core/canvas-skill";
import type { CanvasElement, CanvasParts } from "@plannotator/core/canvas-scene";
import { createCanvasStore, writeCanvasWindows } from "@plannotator/shared/canvas/store";
import { canvasOn } from "@plannotator/shared/canvas/switch";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { formatTopLevelHelp, HIDDEN_SUBCOMMANDS } from "./cli";
import { inboxThreadOnDisk, runCanvasCommand } from "./canvas-command";
import { formatUnknownSubcommandError } from "./unknown-subcommand";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const THREAD = "msg_01M7NQW4XEMG1FHP7SNPFAAE0Y";
const BOARD = [
  '<div id="app" data-frame="phone">',
  ' <p id="title" style="font-size:18px;color:var(--ink)">Settings</p>',
  ' <div id="row-1" style="display:flex;padding:12px"><p id="row-1-label" style="color:var(--ink)">Push alerts</p></div>',
  ' <div id="row-2" style="display:flex;padding:12px"><p id="row-2-label" style="color:var(--ink)">Email</p></div>',
  "</div>",
].join("\n");
const PARTS: CanvasParts = {
  app: { parent: null, kind: "frame" },
  title: { parent: "app", kind: "text", words: "Settings" },
  "row-1": { parent: "app", kind: "box", words: "Push alerts" },
  "row-1-label": { parent: "row-1", kind: "text", words: "Push alerts" },
  "row-2": { parent: "app", kind: "box", words: "Email" },
  "row-2-label": { parent: "row-2", kind: "text", words: "Email" },
};
const el = (id: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasElement> = {}): CanvasElement => ({ id, type: "rectangle", x, y, width: w, height: h, customData: { part: id }, ...extra });
const LAID_OUT: CanvasElement[] = [
  el("app", 0, 0, 390, 800),
  el("title", 20, 20, 100, 24, { type: "text", text: "Settings" }),
  el("row-1", 10, 100, 370, 50),
  el("row-1-label", 20, 115, 100, 20, { type: "text", text: "Push alerts" }),
  el("row-2", 10, 160, 370, 50),
  el("row-2-label", 20, 175, 60, 20, { type: "text", text: "Email" }),
];

function world(options: { exists?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canvas-cli-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const store = createCanvasStore({ dataDir });
  let stdin = "";
  let onSleep: () => void = () => {};
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCanvasCommand(argv, {
      dataDir,
      cwd,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readStdin: async () => stdin,
      alive: (pid) => pid === process.pid,
      layoutWaitMs: 2000,
      sleep: async () => onSleep(),
      threadExists: (id) => (options.exists ?? true) && id === THREAD,
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  /** The window: lay the waiting version out as LAID_OUT. */
  const layOut = (warnings: string[] = []) => {
    const s = store.get(THREAD);
    const done = store.layoutDone(THREAD, { version: s.agentVersion, elements: LAID_OUT, files: {}, warnings, parts: PARTS, changed: 0 });
    if (!done.ok) throw new Error(done.message);
    return done.rev;
  };
  return {
    root,
    dataDir,
    cwd,
    store,
    run,
    layOut,
    setStdin: (s: string) => void (stdin = s),
    whileWaiting: (fn: () => void) => void (onSleep = fn),
    file: (name: string, text: string) => writeFileSync(join(cwd, name), text),
  };
}

describe("hidden while off", () => {
  test("`plannotator --help` never lists canvas, and the unknown-command answer does not name it", () => {
    expect(HIDDEN_SUBCOMMANDS.has("canvas")).toBe(true);
    expect(formatTopLevelHelp()).not.toMatch(/\bcanvas\b/i);
    const answer = formatUnknownSubcommandError("canvas");
    expect(answer.startsWith("Unknown command: canvas")).toBe(true);
    expect(answer).not.toContain("plannotator canvas");
  });

  test("the switch is on only for config.json `inboxCanvas: true`", () => {
    const root = mkdtempSync(join(tmpdir(), "canvas-switch-"));
    roots.push(root);
    const saved = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = root;
    try {
      expect(canvasOn()).toBe(false);
      for (const value of ["true", "1", '"yes"', "false"]) {
        writeFileSync(join(root, "config.json"), `{"inboxCanvas":${value}}`);
        expect(canvasOn()).toBe(value === "true");
      }
      writeFileSync(join(root, "config.json"), "{ not json");
      expect(canvasOn()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = saved;
    }
  });
});

describe("help and arguments", () => {
  test("--help, help and no arguments print the help and exit 0", async () => {
    const w = world();
    for (const argv of [["--help"], ["help"], []]) {
      const r = await w.run(...argv);
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${CANVAS_HELP_TEXT}\n`);
    }
  });

  test("a thread that does not exist, or no thread, is refused and nothing is stored", async () => {
    const w = world({ exists: false });
    w.file("board.html", BOARD);
    const r = await w.run("--thread", THREAD, "--file", "board.html");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`no thread "${THREAD}"`);
    expect(w.store.exists(THREAD)).toBe(false);
    const bad = await world().run("--thread", "../x", "--file", "board.html");
    expect(bad.code).toBe(1);
    expect((await world().run("--file", "board.html")).err).toContain("--thread <id> is required");
    expect((await world().run("draw")).err).toContain('unknown canvas command "draw"');
  });

  test("the default thread check finds a thread's root in the Inbox store on disk", () => {
    const w = world();
    const inbox = InboxStore.open(w.dataDir);
    const project = inbox.ensureProject({ name: "app", root: w.cwd });
    const sent = inbox.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: null }, body: "Drew it.", thread: "Settings" });
    expect(inboxThreadOnDisk(w.dataDir, sent.message.id)).toBe(true);
    expect(inboxThreadOnDisk(w.dataDir, THREAD)).toBe(false);
  });
});

describe("write and patch", () => {
  test("with no window open the board is saved and the agent is told the layout is not checked yet", async () => {
    const w = world();
    w.file("board.html", BOARD);
    let waited = 0;
    w.whileWaiting(() => waited++);
    const r = await w.run("--thread", THREAD, "--file", "board.html");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("saved: board v1");
    expect(r.out).toContain("layout: not checked yet");
    expect(r.out).toContain(`plannotator canvas read --thread ${THREAD}`);
    expect(waited).toBe(0);
    expect(w.store.get(THREAD).board).toContain('id="row-2"');
    expect(w.store.pending()).toEqual([{ id: THREAD, version: 1 }]);
  });

  test("with a window open the command waits for its layout and prints its warnings", async () => {
    const w = world();
    w.file("board.html", BOARD);
    writeCanvasWindows(w.dataDir, 1, process.pid);
    w.whileWaiting(() => w.layOut(["#row-2-label overflows its row"]));
    const r = await w.run("--thread", THREAD, "--file", "board.html");
    expect(r.code).toBe(0);
    expect(r.out).toContain("layout warnings");
    expect(r.out).toContain("- #row-2-label overflows its row");
    expect(r.out).not.toContain("not checked yet");

    w.whileWaiting(() => w.layOut());
    w.setStdin('text #title "Preferences"\n');
    const clean = await w.run("--thread", THREAD, "--patch", "-");
    expect(clean.out).toContain("layout: no problems found.");
  });

  test("a window that was open but whose server is gone is not waited for", async () => {
    const w = world();
    w.file("board.html", BOARD);
    writeCanvasWindows(w.dataDir, 1, 999_999_999);
    let waited = 0;
    w.whileWaiting(() => waited++);
    expect((await w.run("--thread", THREAD, "--file", "board.html")).out).toContain("not checked yet");
    expect(waited).toBe(0);
  });

  test("a board that breaks the rules is not saved", async () => {
    const w = world();
    w.file("page.html", `<html><body>${BOARD}</body></html>`);
    const r = await w.run("--thread", THREAD, "--file", "page.html");
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a full page");
    expect(w.store.exists(THREAD)).toBe(false);
  });

  test("--patch - changes the stored board; a patch naming a missing part changes nothing", async () => {
    const w = world();
    w.setStdin('text #title "Preferences"\n');
    expect((await w.run("--thread", THREAD, "--patch", "-")).err).toContain("no board yet");

    w.file("board.html", BOARD);
    await w.run("--thread", THREAD, "--file", "board.html");
    w.setStdin('text #title "Preferences"\nremove #row-2\n');
    const r = await w.run("--thread", THREAD, "--patch", "-");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("saved: board v2");
    expect(r.out).toContain("2 ops applied");
    const board = w.store.get(THREAD).board;
    expect(board).toContain("Preferences");
    expect(board).not.toContain('id="row-2"');

    w.setStdin('text #nope "x"\n');
    const bad = await w.run("--thread", THREAD, "--patch", "-");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("patch not applied, nothing changed");
    expect(w.store.get(THREAD).board).toBe(board);
    expect(w.store.get(THREAD).agentVersion).toBe(2);
  });
});

describe("read", () => {
  test("read tells the agent what the person did, what is pinned and what is deleted; a patch keeps the pin", async () => {
    const w = world();
    w.file("board.html", BOARD);
    await w.run("--thread", THREAD, "--file", "board.html");
    const rev = w.layOut();
    expect((await w.run("read", "--thread", THREAD)).out).toContain("The person has not changed anything since.");

    // The person moves row 1 down and deletes row 2.
    const now = LAID_OUT.filter((e) => !e.id.startsWith("row-2")).map((e) => (e.id.startsWith("row-1") ? { ...e, y: e.y + 40 } : e));
    expect(w.store.personSave(THREAD, { base: rev, elements: now, files: {} }).ok).toBe(true);
    const r = await w.run("read", "--thread", THREAD);
    expect(r.code).toBe(0);
    expect(r.out).toContain("board v1 is your latest version. Since then the person:");
    expect(r.out).toContain('- moved #row-1 ("Push alerts") by +0,+40');
    expect(r.out).toContain('- deleted #row-2 ("Email")');
    expect(r.out).toContain("pinned (the person moved or resized these; keep their place and size): #row-1");
    expect(r.out).toContain("deleted by the person (leave deleted unless they ask for it back): #row-2");

    const html = await w.run("read", "--thread", THREAD, "--html");
    expect(html.out).toContain("pinned by the person");
    // What row 2 was is told in a comment, for the agent to bring back if asked; the board itself has no row 2.
    expect(html.out).toContain('<!-- #row-2 was: <div id="row-2"');
    const board = html.out.slice(html.out.lastIndexOf("-->") + 3);
    expect(board).toContain('id="row-1"');
    expect(board).not.toContain('id="row-2"');

    // The agent's next patch keeps the person's place for row 1.
    w.setStdin('text #title "Preferences"\n');
    await w.run("--thread", THREAD, "--patch", "-");
    expect(w.store.get(THREAD).standing.pins["row-1"]).toEqual({ x: 10, y: 140, w: 370, h: 50 });
    expect((await w.run("read", "--thread", THREAD)).out).toContain("layout: v3 is not laid out yet"); // v2 was the person's
  });

  test("read --png names the kept picture, or says there is none yet", async () => {
    const w = world();
    w.file("board.html", BOARD);
    await w.run("--thread", THREAD, "--file", "board.html");
    const none = await w.run("read", "--thread", THREAD, "--png");
    expect(none.code).toBe(1);
    expect(none.out).toContain("no picture yet");
    const rev = w.layOut();
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    expect(w.store.savePicture(THREAD, { rev, bytes: png })).toBe(true);
    const r = await w.run("read", "--thread", THREAD, "--png");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(w.store.picturePath(THREAD));
  });
});
