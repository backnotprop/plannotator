/**
 * `plannotator canvas …`: an agent's side of the thread canvas (docs/agent-guides/inbox-canvas.md). It reads and
 * writes the canvas store directly (`@plannotator/shared/canvas/store`).
 *
 * A write is checked by the board rules (`@plannotator/core/canvas-board`), stored as the agent's next version, and
 * laid out by an Inbox window: a real browser engine measures the words and places every part. While a window is
 * open the command waits for that layout and prints its warnings; with none open it says so and the layout runs
 * when a window opens (`read` shows the warnings then).
 *
 * Only while the person has the canvas on (config.json `inboxCanvas`); off, apps/hook/server/index.ts answers as for
 * an unknown command before this file is reached.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { patchBoard, savedReply, writeBoard, type BoardPictures } from "@plannotator/core/canvas-board";
import { CANVAS_HELP_TEXT } from "@plannotator/core/canvas-skill";
import { canvasWindowOpen, CANVAS_ID_RE, createCanvasStore, type CanvasStore } from "@plannotator/shared/canvas/store";
import { inboxDir, INBOX_PROJECTS_DIR, MESSAGES_FILE } from "@plannotator/shared/inbox/schema";

export interface CanvasCommandDeps {
  dataDir: string;
  cwd: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** All of stdin (for `--patch -` and `--file -`). */
  readStdin?: () => Promise<string>;
  /** Whether a process is running (the Inbox server that says a window is open). */
  alive?: (pid: number) => boolean;
  /** How long to wait for a window's layout (default 20 s). */
  layoutWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether the thread exists (default: the Inbox store on disk has its root message). */
  threadExists?: (id: string) => boolean;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The thread's root message is in the Inbox store on disk. */
export function inboxThreadOnDisk(dataDir: string, id: string): boolean {
  const projects = join(inboxDir(dataDir), INBOX_PROJECTS_DIR);
  let names: string[];
  try {
    names = readdirSync(projects);
  } catch {
    return false;
  }
  const needle = `"id":"${id}"`;
  for (const name of names) {
    try {
      if (readFileSync(join(projects, name, MESSAGES_FILE), "utf8").includes(needle)) return true;
    } catch {
      // not a project folder
    }
  }
  return false;
}

function flag(args: string[], name: string): { present: boolean; value: string | null } {
  const i = args.indexOf(name);
  if (i === -1) return { present: false, value: null };
  const v = args[i + 1];
  return { present: true, value: v === undefined || (v.startsWith("--") && v !== "-") ? null : v };
}

/** Pictures named by an absolute path are copied into the canvas; ones already there stay as they are. */
function picturesFor(store: CanvasStore, id: string): BoardPictures {
  const own = join(store.folder(id), "files");
  return {
    resolve(src, baseDir) {
      if (src.startsWith("files/") && store.filePath(id, src)) return { ok: true, src };
      const path = isAbsolute(src) ? src : resolve(baseDir, src);
      if (dirname(path) === own && store.filePath(id, path.slice(own.length + 1))) return { ok: true, src: `files/${path.slice(own.length + 1)}` };
      if (!existsSync(path)) return { ok: false, error: `picture file not found: ${path}` };
      const copied = store.copyPicture(id, path);
      return copied.ok ? { ok: true, src: `files/${copied.name}` } : { ok: false, error: copied.error };
    },
  };
}

/** The stored board, its pictures named by their full path (what an agent can open and send back). */
const boardForAgent = (store: CanvasStore, id: string, html: string) =>
  html.replace(/src="files\/([^"]+)"/g, (m, name: string) => {
    const p = store.filePath(id, name);
    return p ? `src="${p}"` : m;
  });

export async function runCanvasCommand(args: string[], deps: CanvasCommandDeps): Promise<number> {
  const out = deps.stdout ?? ((t: string) => process.stdout.write(t));
  const err = deps.stderr ?? ((t: string) => process.stderr.write(t));
  const die = (msg: string, code: number) => {
    err(`${msg}\n`);
    return code;
  };
  if (args.length === 0 || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    out(`${CANVAS_HELP_TEXT}\n`);
    return 0;
  }
  const reading = args[0] === "read";
  const rest = reading ? args.slice(1) : args;
  if (!reading && !["--thread", "--file", "--patch"].includes(args[0])) {
    return die(`error: unknown canvas command "${args[0]}". Commands: --file, --patch, read. See plannotator canvas --help`, 1);
  }
  const thread = flag(rest, "--thread");
  if (!thread.present) return die("error: --thread <id> is required (your thread id is in your task)", 1);
  if (!thread.value) return die("error: --thread needs an id", 1);
  const id = thread.value;
  const exists = deps.threadExists ?? ((t: string) => inboxThreadOnDisk(deps.dataDir, t));
  if (!CANVAS_ID_RE.test(id) || !exists(id)) return die(`error: no thread "${id}". Check the thread id you were given.`, 1);
  const store = createCanvasStore({ dataDir: deps.dataDir });

  if (reading) return read(store, id, rest, out);

  const file = flag(args, "--file");
  const patch = flag(args, "--patch");
  if (file.present && patch.present) return die("error: use --file or --patch, not both", 1);
  if (!file.present && !patch.present) return die("error: say what to do: --file board.html, --patch -, or read. See plannotator canvas --help", 1);
  const stdin = deps.readStdin ?? (() => new Response(Bun.stdin.stream()).text());

  let src: string;
  let baseDir = deps.cwd;
  if (file.present) {
    if (!file.value) return die("error: --file needs a path (use --patch - to change an existing board)", 1);
    if (file.value === "-") src = await stdin();
    else {
      const path = resolve(deps.cwd, file.value);
      if (!existsSync(path)) return die(`error: file not found: ${file.value}`, 1);
      src = readFileSync(path, "utf8");
      baseDir = dirname(path);
    }
  } else {
    const p = patch.value ?? "-";
    if (p === "-") src = await stdin();
    else {
      const path = resolve(deps.cwd, p);
      if (!existsSync(path)) return die(`error: patch file not found: ${p}`, 1);
      src = readFileSync(path, "utf8");
    }
  }

  const state = store.get(id);
  const pictures = picturesFor(store, id);
  let html: string;
  let pins = state.standing.pins;
  let extra = "";
  let patched: { applied: string[]; notes: string[] } | undefined;
  let root;
  if (file.present) {
    const w = writeBoard(src, state.standing, state.agentVersion, pictures, baseDir);
    if (!w.ok) return die(w.error, 2);
    html = w.html;
    pins = w.pins;
    extra = w.extra;
    root = w.root;
  } else {
    if (state.agentVersion === 0) return die("error: this thread has no board yet; write one first with --file board.html", 2);
    const p = patchBoard(state.board, src, state.standing, id, pictures, baseDir);
    if (!p.ok) return die(p.error, 2);
    html = p.html;
    pins = p.pins;
    root = p.root;
    extra = `; ${p.ops} op${p.ops === 1 ? "" : "s"} applied`;
    patched = { applied: p.applied, notes: p.notes };
  }
  const saved = store.agentWrite(id, { board: html, pins, applied: patched?.applied ?? [] });
  const v = saved.agentVersion;
  const warnings = await waitForLayout(store, id, v, deps);
  out(`${savedReply(v, root, warnings, extra, patched).replace("--thread <id>", `--thread ${id}`)}\n`);
  return 0;
}

async function waitForLayout(store: CanvasStore, id: string, version: number, deps: CanvasCommandDeps): Promise<string[] | null> {
  if (!canvasWindowOpen(deps.dataDir, deps.alive ?? isAlive)) return null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + (deps.layoutWaitMs ?? 20_000);
  for (;;) {
    const s = store.get(id);
    if (s.agentVersion !== version) return null;
    if (s.layout?.version === version && s.layout.state === "done") return s.layout.warnings;
    if (Date.now() > until) return null;
    await sleep(100);
  }
}

function read(store: CanvasStore, id: string, args: string[], out: (t: string) => void): number {
  const s = store.get(id);
  const lines = store.readBack(id);
  if (s.agentVersion === 0) {
    if (lines.length) out(`${["You have not drawn on this canvas yet. The person:", ...lines.map((l) => `- ${l}`)].join("\n")}\n`);
    else out(`no board yet on thread ${id}. Write one with: plannotator canvas --thread ${id} --file board.html\n`);
    if (!args.includes("--png")) return 0;
  }
  if (args.includes("--html")) {
    const o: string[] = [];
    const pins = Object.keys(s.standing.pins);
    if (pins.length) o.push(`<!-- pinned by the person (moved or resized; keep their place and size): ${pins.map((p) => `#${p}`).join(", ")} -->`);
    if (s.standing.deleted.length) {
      o.push(`<!-- deleted by the person: ${s.standing.deleted.map((p) => `#${p}`).join(", ")} -->`);
      for (const [d, h] of Object.entries(s.standing.deletedHtml)) o.push(`<!-- #${d} was: ${h.replace(/--/g, "- -")} -->`);
    }
    o.push(boardForAgent(store, id, s.board).trimEnd());
    out(`${o.join("\n")}\n`);
    return 0;
  }
  if (args.includes("--png")) {
    const p = store.picturePath(id);
    if (!p) {
      out("error: no picture yet. The Inbox makes one when its window lays the canvas out or shows it; none has yet.\n");
      return 1;
    }
    out(`${p}\n`);
    if ((s.png?.rev ?? 0) < s.rev) out("(this picture is from before the latest change; the Inbox makes a new one while its window is open)\n");
    return 0;
  }
  const v = s.agentVersion;
  const o = lines.length ? [`board v${v} is your latest version. Since then the person:`, ...lines.map((l) => `- ${l}`)] : [`board v${v} is your latest version. The person has not changed anything since.`];
  const pins = Object.keys(s.standing.pins);
  if (pins.length) o.push(`pinned (the person moved or resized these; keep their place and size): ${pins.map((p) => `#${p}`).join(", ")}`);
  if (s.standing.deleted.length) {
    o.push(`deleted by the person (leave deleted unless they ask for it back): ${s.standing.deleted.map((p) => `#${p}`).join(", ")}`);
    for (const [d, h] of Object.entries(s.standing.deletedHtml)) o.push(`  #${d} was: ${boardForAgent(store, id, h)}`);
  }
  if (s.layout?.version === v && s.layout.state === "pending") o.push(`layout: v${v} is not laid out yet; the Inbox lays it out when its window is open.`);
  else if (s.layout?.version === v && s.layout.warnings.length) o.push("layout warnings (fix with a patch):", ...s.layout.warnings.map((w) => `- ${w}`));
  out(`${o.join("\n")}\n`);
  return 0;
}
