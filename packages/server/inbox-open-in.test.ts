/**
 * "Open in" for Inbox attachments (packages/server/inbox-open-in.ts, the
 * page route in inbox-attachments.ts), proved against a real Inbox on
 * loopback with real `fetch`. No real app ever starts: the launch tests pass
 * a recording launcher (`openInLauncher`), and the one test of the real
 * launcher puts ONLY a scratch folder of stubs (`open`, `xdg-open`) on PATH
 * while it runs, so a launcher that is not a stub cannot be found. Every test
 * has its own temp data dir; Tailscale is a scripted runner, never the CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenInApp, type OpenInApp, type OpenInPlatform } from "@plannotator/core/open-in-apps";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { createShapeStore } from "@plannotator/shared/shape/store";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { systemOpenInLauncher, type InboxOpenInLauncher } from "./inbox-open-in";
import { openWithApp, type AvailableOpenInApp } from "./open-in";

type Json = Record<string, any>;

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

/** A project folder with one file of every kind the policy distinguishes. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-openin-")));
  roots.push(root);
  const dataDir = join(root, "data");
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const files: Record<string, string | Buffer> = {
    "plan.md": "# Plan\n",
    "notes.txt": "notes\n",
    "rows.csv": "a,b\n1,2\n",
    "deploy.sh": "#!/bin/sh\necho deploy\n",
    "page.html": "<!doctype html><title>Checkout</title><img src=\"shot.png\"><h1 id=\"top\">Checkout</h1>\n",
    ".draft.html": "<!doctype html><title>Draft</title><p>draft</p>\n",
    "shot.png": PNG,
    "run.command": PNG,
    "spec.pdf": PDF,
    "build.zip": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0xff, 0xfe]),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(project, name), bytes);
  return { root, dataDir, project };
}

type Launch = { how: "reveal" | "app" | "default"; path: string; app?: string; line?: number };

/** A launcher that records instead of starting anything. */
function recordingLauncher(platform: OpenInPlatform, apps: string[] = ["reveal", "vscode", "cursor", "terminal"], answer: { ok: true } | { ok: false; error: string } = { ok: true }) {
  const launches: Launch[] = [];
  const catalog: Record<string, AvailableOpenInApp> = {
    reveal: { id: "reveal", label: "Finder", kind: "file-manager", icon: "finder" },
    vscode: { id: "vscode", label: "VS Code", kind: "editor", icon: "vscode" },
    cursor: { id: "cursor", label: "Cursor", kind: "editor", icon: "cursor" },
    terminal: { id: "terminal", label: "Terminal", kind: "terminal", icon: "terminal" },
  };
  const launcher: InboxOpenInLauncher = {
    platform,
    apps: () => apps.map((id) => catalog[id]!),
    reveal: async (path) => (launches.push({ how: "reveal", path }), answer),
    openWithApp: async (app: OpenInApp, path, line) => (launches.push({ how: "app", path, app: app.id, ...(line ? { line } : {}) }), answer),
    openWithSystemDefault: async (path) => (launches.push({ how: "default", path }), answer),
  };
  return { launcher, launches };
}

async function start(dataDir: string, extra: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, ...extra });
  servers.push(server);
  return server;
}

/** One message carrying every file of the project; their ids by name. */
async function attach(server: InboxServer, project: string, names: string[]): Promise<Record<string, string>> {
  const prj = server.store.ensureProject({ name: "billing", root: project });
  const attachments = await recordInboxAttachments(server.store.dir, names, { base: project, at: new Date().toISOString() });
  server.store.sendMessage({ project_id: prj.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: "Files.", attachments });
  // Keyed by the name the agent gave (a symlink's own name), as `names` lists them.
  return Object.fromEntries(attachments.map((a, i) => [names[i]!, a.id]));
}

function openIn(server: InboxServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const answerOf = async (response: Response): Promise<[number, string | undefined]> => [response.status, ((await response.json()) as Json).code];

const ALL = ["plan.md", "notes.txt", "rows.csv", "deploy.sh", "page.html", ".draft.html", "shot.png", "run.command", "spec.pdf", "build.zip"];

describe("Inbox Open in: the launch route", () => {
  test("the apps route lists the file manager and the editors (never a terminal), with the platform", async () => {
    const { dataDir } = world();
    const { launcher } = recordingLauncher("mac");
    const server = await start(dataDir, { openInLauncher: launcher });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in/apps`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;
    expect(body.available).toBe(true);
    expect(body.platform).toBe("mac");
    expect(body.apps.map((a: Json) => a.id)).toEqual(["reveal", "vscode", "cursor"]);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in/apps`, { method: "POST", body: "{}" })).status).toBe(405);
  });

  test("the per-kind policy: what each kind opens in, and every launch gets the record's realpath", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac");
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ALL);
    const allowed = async (name: string, app: string) => (await openIn(server, { attachment_id: ids[name], app_id: app })).status;
    const table: [string, string, number][] = [
      // Markdown, text and code: editors; the default app only for md/txt/json/yaml/toml/log (macOS, Windows).
      ["plan.md", "vscode", 200],
      ["plan.md", "default", 200],
      ["notes.txt", "default", 200],
      ["rows.csv", "vscode", 200],
      ["rows.csv", "default", 422],
      ["deploy.sh", "cursor", 200],
      ["deploy.sh", "default", 422],
      // HTML: editors and the file manager; never the OS default (Browser is the window's link).
      ["page.html", "vscode", 200],
      ["page.html", "default", 422],
      ["page.html", "browser", 422],
      // Images and PDFs: their viewer when the bytes and the extension agree; no editor.
      ["shot.png", "default", 200],
      ["shot.png", "vscode", 422],
      ["run.command", "default", 422],
      ["spec.pdf", "default", 200],
      // Anything else: the file manager only.
      ["build.zip", "reveal", 200],
      ["build.zip", "default", 422],
      ["build.zip", "vscode", 422],
      // Never a terminal, whatever the kind.
      ["plan.md", "terminal", 422],
      ["plan.md", "reveal", 200],
    ];
    const answered: [string, string, number][] = [];
    for (const [name, app] of table) answered.push([name, app, await allowed(name, app)]);
    expect(answered).toEqual(table);
    // run.command is a PNG by its bytes, so the Inbox calls it an image; its name would still run it.
    expect(server.store.attachment(ids["run.command"]!)!.attachment.kind).toBe("image");
    // Every launch went to the realpath the record holds.
    expect(launches.every((launch) => launch.path === realpathSync(join(project, launch.path.split("/").pop()!)))).toBe(true);
    expect(launches.filter((l) => l.how === "default").map((l) => l.path.split("/").pop())).toEqual(["plan.md", "notes.txt", "shot.png", "spec.pdf"]);
    expect(launches.filter((l) => l.how === "app").map((l) => `${l.app}:${l.path.split("/").pop()}`)).toEqual(["vscode:plan.md", "vscode:rows.csv", "cursor:deploy.sh", "vscode:page.html"]);
  });

  test("on Linux no text kind gets the default app; images and PDFs still do", async () => {
    const { dataDir, project } = world();
    const { launcher } = recordingLauncher("linux");
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md", "notes.txt", "shot.png", "spec.pdf"]);
    const statuses = [];
    for (const name of ["plan.md", "notes.txt", "shot.png", "spec.pdf"]) statuses.push((await openIn(server, { attachment_id: ids[name], app_id: "default" })).status);
    expect(statuses).toEqual([422, 422, 200, 200]);
  });

  test("refusals: another site, a sandboxed page, a stale tab, a bad body, an unknown id or app, an editor not installed; nothing launches", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac", ["reveal", "vscode"]);
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md"]);
    const id = ids["plan.md"]!;
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "vscode" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }))).toEqual([403, "cross_origin"]);
    // An attached page runs at an opaque origin: Origin null is another site.
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "vscode" }, { Origin: "null" }))).toEqual([403, "cross_origin"]);
    // A preflight-free text/plain POST from another localhost port is refused too.
    expect(await answerOf(await openIn(server, JSON.stringify({ attachment_id: id, app_id: "vscode" }), { "Content-Type": "text/plain", "Sec-Fetch-Site": "same-site", Origin: "http://localhost:1" }))).toEqual([403, "cross_origin"]);
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "vscode", serverSession: "an-older-inbox" }))).toEqual([409, "session_mismatch"]);
    expect(await answerOf(await openIn(server, { app_id: "vscode" }))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, { attachment_id: "../../etc/passwd", app_id: "vscode" }))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, { attachment_id: id }))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, "not json"))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, { attachment_id: "att_01K7ZZZZZZZZZZZZZZZZZZZZZZ", app_id: "vscode" }))).toEqual([404, "attachment_not_found"]);
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "not-an-app" }))).toEqual([422, "open_not_allowed"]);
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "cursor" }))).toEqual([422, "app_not_available"]);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in`)).status).toBe(405);
    expect(launches).toEqual([]);
    // A path in the body is never read: the record's realpath is what launches.
    const ok = await openIn(server, { attachment_id: id, app_id: "vscode", path: "/etc/passwd", filePath: "/etc/passwd" });
    expect(await ok.json()).toEqual({ ok: true });
    expect(launches).toEqual([{ how: "app", app: "vscode", path: join(project, "plan.md") }]);
  });

  test("the file is checked again at launch: gone, a symlink that now points elsewhere, an image that is no longer an image", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac");
    writeFileSync(join(project, "real.md"), "# Real\n");
    symlinkSync(join(project, "real.md"), join(project, "link.md"));
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md", "link.md", "shot.png"]);
    unlinkSync(join(project, "plan.md"));
    expect(await answerOf(await openIn(server, { attachment_id: ids["plan.md"], app_id: "reveal" }))).toEqual([404, "attachment_missing"]);
    writeFileSync(join(project, "other.md"), "# Other\n");
    unlinkSync(join(project, "link.md"));
    symlinkSync(join(project, "other.md"), join(project, "link.md"));
    expect(await answerOf(await openIn(server, { attachment_id: ids["link.md"], app_id: "vscode" }))).toEqual([409, "attachment_changed_type"]);
    writeFileSync(join(project, "shot.png"), "#!/bin/sh\necho not an image\n");
    expect(await answerOf(await openIn(server, { attachment_id: ids["shot.png"], app_id: "default" }))).toEqual([409, "attachment_changed_type"]);
    expect(launches).toEqual([]);
  });

  test("a launch that fails answers 200 with the reason, as /api/open-in does", async () => {
    const { dataDir, project } = world();
    const { launcher } = recordingLauncher("mac", ["reveal", "vscode"], { ok: false, error: "VS Code not found" });
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md"]);
    const response = await openIn(server, { attachment_id: ids["plan.md"], app_id: "vscode" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: "VS Code not found" });
  });
});

describe("Inbox Open in: a file a reference names", () => {
  const FILE = "/api/inbox/open-in/file";
  const REPO = "github.com/acme/billing";

  /** An Inbox with Code review and Shape on, a thread in the project, a shape on it, and the project on a repository. */
  async function referenced(extra: Parameters<typeof startInboxServer>[0] = {}) {
    const w = world();
    const made = createShapeStore({ dataDir: w.dataDir }).update({
      board: { title: "Kettle", claim: "Built.", views: { picture: { html: '<p data-mark="k">One whistle</p>' } } },
      project: { root: w.project, name: "billing" },
      session: { id: "ses_a", host: "claude-code" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const recording = recordingLauncher("mac");
    const server = await start(w.dataDir, {
      openInLauncher: recording.launcher,
      codeReview: true,
      shape: true,
      readProjectRepo: async () => ({ display: "acme/billing", host: "github.com" }),
      ...extra,
    });
    const prj = server.store.ensureProject({ name: "billing", root: w.project });
    const sent = server.store.sendMessage({ project_id: prj.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: "A review." });
    const base = `http://127.0.0.1:${server.port}`;
    const check = async (query: Record<string, string>) => (await (await fetch(`${base}${FILE}?${new URLSearchParams(query)}`)).json()) as Json;
    const open = (body: Json) => fetch(`${base}${FILE}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ...w, server, ...recording, thread: sent.message.thread_id, shape: made.id, base, check, open };
  }

  test("opens the file at its real path and line, from a thread, a shape or a PR's repository", async () => {
    const r = await referenced();
    mkdirSync(join(r.project, "src"));
    writeFileSync(join(r.project, "src/app.ts"), "export {};\n");
    const path = join(r.project, "src/app.ts");

    for (const scope of [{ thread: r.thread }, { shape: r.shape }]) {
      expect(await r.check({ ...scope, path: "src/app.ts" })).toEqual({ found: true, path, kind: "code" });
      expect(await (await r.open({ ...scope, path: "src/app.ts", app_id: "vscode", line: 12 })).json()).toEqual({ ok: true });
    }
    expect(r.launches).toEqual([
      { how: "app", path, app: "vscode", line: 12 },
      { how: "app", path, app: "vscode", line: 12 },
    ]);
    r.launches.length = 0;
    // A project's origin is read behind the first ask for it (the PR page's list has asked by then).
    await r.check({ repo: REPO, path: "src/app.ts" });
    await Bun.sleep(30);
    expect(await r.check({ repo: REPO, path: "src/app.ts" })).toEqual({ found: true, path, kind: "code" });
    await r.open({ repo: REPO, path: "src/app.ts", app_id: "reveal" });
    expect(r.launches).toEqual([{ how: "reveal", path }]);
  });

  test("a file that is not here: found is false, and a launch answers missing", async () => {
    const r = await referenced();
    expect(await r.check({ thread: r.thread, path: "src/gone.ts" })).toEqual({ found: false });
    expect(await answerOf(await r.open({ thread: r.thread, path: "src/gone.ts", app_id: "vscode" }))).toEqual([404, "attachment_missing"]);
    // A repository no project here is on, and a thread or shape that does not exist: nothing to find it in.
    expect(await r.check({ repo: "github.com/acme/elsewhere", path: "plan.md" })).toEqual({ found: false });
    expect(await r.check({ thread: "msg_nope", path: "plan.md" })).toEqual({ found: false });
    expect(await r.check({ shape: "shp_nope", path: "plan.md" })).toEqual({ found: false });
    expect(await r.check({ path: "plan.md" })).toEqual({ found: false });
    expect(r.launches).toEqual([]);
  });

  test("a path outside the project is refused, however it is written, and so is a secret", async () => {
    const r = await referenced();
    writeFileSync(join(r.root, "secret.txt"), "outside\n");
    writeFileSync(join(r.project, ".env"), "KEY=1\n");
    symlinkSync(join(r.root, "secret.txt"), join(r.project, "out.txt"));
    symlinkSync(r.root, join(r.project, "up"));
    symlinkSync(join(r.project, ".env"), join(r.project, "config.txt"));
    for (const path of ["../secret.txt", "src/../../secret.txt", join(r.root, "secret.txt"), "~/secret.txt", "out.txt", "up/secret.txt", ".env", ".env::$DATA", "config/.env .", "config.txt", "..%2fsecret.txt"]) {
      expect([path, await r.check({ thread: r.thread, path })]).toEqual([path, { found: false }]);
      expect([path, ...(await answerOf(await r.open({ thread: r.thread, path, app_id: "vscode" })))]).toEqual([path, 422, "open_not_allowed"]);
    }
    expect(r.launches).toEqual([]);
    // A root in the request means nothing.
    expect(await r.check({ thread: r.thread, root: r.root, path: "secret.txt" })).toEqual({ found: false });
  });

  test("the per-kind policy holds: a script opens in an editor, never its default app; an unknown file only in Finder", async () => {
    const r = await referenced();
    expect(await answerOf(await r.open({ thread: r.thread, path: "deploy.sh", app_id: "default" }))).toEqual([422, "open_not_allowed"]);
    expect(await answerOf(await r.open({ thread: r.thread, path: "build.zip", app_id: "vscode" }))).toEqual([422, "open_not_allowed"]);
    expect(await answerOf(await r.open({ thread: r.thread, path: "plan.md", app_id: "terminal" }))).toEqual([422, "open_not_allowed"]);
    expect(await answerOf(await r.open({ thread: r.thread, path: "run.command", app_id: "default" }))).toEqual([422, "open_not_allowed"]);
    expect(r.launches).toEqual([]);
    await r.open({ thread: r.thread, path: "deploy.sh", app_id: "cursor" });
    await r.open({ thread: r.thread, path: "shot.png", app_id: "default" });
    expect(r.launches.map((l) => l.how)).toEqual(["app", "default"]);
  });

  /** A linked worktree of the project, as git leaves it: a folder whose `.git` is a file. */
  function worktree(r: { root: string }, name: string, files: Record<string, string>) {
    const dir = realpathSync(mkdtempSync(join(r.root, `${name}-`)));
    const gitdir = join(dir, "..", `${name}-gitdir-${dir.slice(-6)}`);
    mkdirSync(gitdir);
    writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }

  const AGENT = { kind: "agent", host: "claude-code", session: "ses_b", name: "Claude Code" } as const;

  test("an agent in a linked worktree: its links open the worktree's file, never the main checkout's copy", async () => {
    const r = await referenced();
    mkdirSync(join(r.project, "src"));
    writeFileSync(join(r.project, "src/app.ts"), "main\n");
    writeFileSync(join(r.project, "src/only-main.ts"), "main\n");
    const wt = worktree(r, "wt", { "src/app.ts": "worktree\n", "src/only-here.ts": "worktree\n" });
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path: wt });
    const scope = { thread: sent.message.thread_id, message: sent.message.id };

    expect((await r.check({ ...scope, path: "src/app.ts" })).path).toBe(join(wt, "src/app.ts"));
    expect((await r.check({ ...scope, path: "src/only-here.ts" })).path).toBe(join(wt, "src/only-here.ts"));
    expect((await r.check({ ...scope, path: join(wt, "src/app.ts") })).path).toBe(join(wt, "src/app.ts"));
    // A file the worktree does not have: the main checkout's copy is not the agent's file.
    expect(await r.check({ ...scope, path: "src/only-main.ts" })).toEqual({ found: false });
    // Named absolutely, it means that file.
    expect((await r.check({ ...scope, path: join(r.project, "src/only-main.ts") })).path).toBe(join(r.project, "src/only-main.ts"));

    await r.open({ ...scope, path: "src/app.ts", app_id: "reveal" });
    expect(r.launches).toEqual([{ how: "reveal", path: join(wt, "src/app.ts") }]);
  });

  test("a worktree that is gone: the project's own copy", async () => {
    const r = await referenced();
    writeFileSync(join(r.project, "plan.md"), "# main\n");
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path: join(r.root, "removed-worktree") });
    expect((await r.check({ thread: sent.message.thread_id, message: sent.message.id, path: "plan.md" })).path).toBe(join(r.project, "plan.md"));
  });

  test("a board written from a linked worktree opens that worktree's file, and the project's once the worktree is gone", async () => {
    const r = await referenced();
    writeFileSync(join(r.project, "app.ts"), "main\n");
    const wt = worktree(r, "wt", { "app.ts": "worktree\n", "new.ts": "worktree\n" });
    const made = createShapeStore({ dataDir: r.dataDir }).update({
      board: { title: "Tree", claim: "Built.", views: { picture: { html: '<p data-mark="k">One</p>' } } },
      project: { root: r.project, name: "billing", worktree: wt },
      session: { id: "ses_a", host: "claude-code" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await r.check({ shape: made.id, path: "app.ts" })).path).toBe(join(wt, "app.ts"));
    expect((await r.check({ shape: made.id, path: "new.ts" })).path).toBe(join(wt, "new.ts"));
    // Its file viewer reads the same checkout.
    const read = (await (await fetch(`${r.base}/api/shapes/${made.id}/code/file?path=app.ts`)).json()) as Json;
    expect(JSON.stringify(read)).toContain("worktree");
    rmSync(wt, { recursive: true, force: true });
    expect((await r.check({ shape: made.id, path: "app.ts" })).path).toBe(join(r.project, "app.ts"));
  });

  test("a real worktree under the project (`.claude/worktrees/n`): a file only in main is not the agent's", async () => {
    const r = await referenced();
    const git = (...args: string[]) => {
      const done = spawnSync("git", ["-C", r.project, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      if (done.status !== 0) throw new Error(done.stderr);
    };
    mkdirSync(join(r.project, "src"));
    writeFileSync(join(r.project, "src/app.ts"), "main\n");
    git("init", "-q");
    git("add", "src/app.ts");
    git("commit", "-qm", "one");
    git("worktree", "add", "-q", "-b", "n", ".claude/worktrees/n");
    writeFileSync(join(r.project, "src/main-new.ts"), "main\n");
    const nested = join(r.project, ".claude/worktrees/n");
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path: nested });
    const scope = { thread: sent.message.thread_id, message: sent.message.id };
    expect((await r.check({ ...scope, path: "src/app.ts" })).path).toBe(join(nested, "src/app.ts"));
    expect(await r.check({ ...scope, path: "src/main-new.ts" })).toEqual({ found: false });
  });

  test("a diff's path starts at the top of the repository, an agent's link at its folder", async () => {
    const r = await referenced();
    mkdirSync(join(r.project, "packages/server"), { recursive: true });
    writeFileSync(join(r.project, "package.json"), "{}\n");
    writeFileSync(join(r.project, "packages/server/package.json"), "{}\n");
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path: join(r.project, "packages/server") });
    const scope = { thread: sent.message.thread_id, message: sent.message.id };
    expect((await r.check({ ...scope, path: "package.json" })).path).toBe(join(r.project, "packages/server/package.json"));
    expect((await r.check({ ...scope, from: "root", path: "package.json" })).path).toBe(join(r.project, "package.json"));
    await r.open({ ...scope, from: "root", path: "package.json", app_id: "reveal" });
    expect(r.launches).toEqual([{ how: "reveal", path: join(r.project, "package.json") }]);
  });

  test("a branch switch removed the agent's subfolder: still its worktree, not main", async () => {
    const r = await referenced();
    mkdirSync(join(r.project, "src"));
    writeFileSync(join(r.project, "src/app.ts"), "main\n");
    writeFileSync(join(r.project, "src/only-main.ts"), "main\n");
    const wt = worktree(r, "wt", { "src/app.ts": "worktree\n" });
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path: join(wt, "feat") });
    const scope = { thread: sent.message.thread_id, message: sent.message.id };
    expect((await r.check({ ...scope, path: "src/app.ts" })).path).toBe(join(wt, "src/app.ts"));
    expect(await r.check({ ...scope, path: "src/only-main.ts" })).toEqual({ found: false });
  });

  test("a base_path is no way in: not a folder without a `.git`, not the home folder even with one", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "open-in-home-")));
    roots.push(dir);
    const home = join(dir, "home");
    mkdirSync(join(home, ".git"), { recursive: true });
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/id_rsa"), "secret\n");
    mkdirSync(join(home, "notes"));
    writeFileSync(join(home, "notes/a.md"), "# a\n");
    const loose = join(dir, "etc");
    mkdirSync(loose);
    writeFileSync(join(loose, "hosts"), "secret\n");
    const r = await referenced({ openInHome: home });
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    for (const base_path of [home, join(home, "notes"), loose]) {
      const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path });
      const scope = { thread: sent.message.thread_id, message: sent.message.id };
      for (const path of [".ssh/id_rsa", "notes/a.md", "hosts", "../.ssh/id_rsa"]) expect((await r.check({ ...scope, path })).found).toBe(false);
      expect((await r.check({ ...scope, path: join(home, ".ssh/id_rsa") })).found).toBe(false);
    }
  });

  test("the home folder by another spelling is still the home folder", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "open-in-home-")));
    roots.push(dir);
    const home = join(dir, "home");
    mkdirSync(join(home, ".git"), { recursive: true });
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/id_rsa"), "secret\n");
    const spelled = join(dir, "linkhome");
    symlinkSync(home, spelled);
    // The home folder named through a link, a base under the real folder; the home folder real, a base through the link.
    for (const [openInHome, base_path] of [[spelled, home], [home, spelled]] as const) {
      const r = await referenced({ openInHome });
      const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
      const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path });
      expect((await r.check({ thread: sent.message.thread_id, message: sent.message.id, path: ".ssh/id_rsa" })).found).toBe(false);
    }
  });

  test("a `.git` file that names nothing is no worktree", async () => {
    const r = await referenced();
    writeFileSync(join(r.project, "app.ts"), "main\n");
    for (const dotGit of ["", "not a gitdir line\n", `gitdir: ${join(r.root, "nowhere")}\n`]) {
      const loose = realpathSync(mkdtempSync(join(r.root, "loose-")));
      writeFileSync(join(loose, ".git"), dotGit);
      writeFileSync(join(loose, "hosts"), "secret\n");
      const made = createShapeStore({ dataDir: r.dataDir }).update({
        board: { title: "Tree", claim: "Built.", views: { picture: { html: '<p data-mark="k">One</p>' } } },
        project: { root: r.project, name: "billing", worktree: loose },
        session: { id: "ses_a", host: "claude-code" },
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      expect(await r.check({ shape: made.id, path: "hosts" })).toEqual({ found: false });
    }
  });

  test("a board's worktree that is not one (no `.git` file) is not read: not by Open in, not by its file viewer", async () => {
    const r = await referenced();
    writeFileSync(join(r.project, "app.ts"), "main\n");
    const loose = realpathSync(mkdtempSync(join(r.root, "etc-")));
    writeFileSync(join(loose, "hosts"), "secret\n");
    const made = createShapeStore({ dataDir: r.dataDir }).update({
      board: { title: "Tree", claim: "Built.", views: { picture: { html: '<p data-mark="k">One</p>' } } },
      project: { root: r.project, name: "billing", worktree: loose },
      session: { id: "ses_a", host: "claude-code" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(await r.check({ shape: made.id, path: "hosts" })).toEqual({ found: false });
    expect((await r.check({ shape: made.id, path: "app.ts" })).path).toBe(join(r.project, "app.ts"));
    const read = await (await fetch(`${r.base}/api/shapes/${made.id}/code/file?path=hosts`)).text();
    expect(read).not.toContain("secret");
  });

  test("an agent in a subfolder: a link starts at its folder, and at the top of its checkout", async () => {
    const r = await referenced();
    mkdirSync(join(r.project, "src"));
    writeFileSync(join(r.project, "src/ledger.ts"), "ledger\n");
    writeFileSync(join(r.project, "src/near.ts"), "near\n");
    writeFileSync(join(r.project, "near.ts"), "top\n");
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Look.", base_path: join(r.project, "src") });
    const scope = { thread: sent.message.thread_id, message: sent.message.id };
    expect((await r.check({ ...scope, path: "src/ledger.ts" })).path).toBe(join(r.project, "src/ledger.ts"));
    expect((await r.check({ ...scope, path: "near.ts" })).path).toBe(join(r.project, "src/near.ts"));
    expect((await r.check({ ...scope, path: "../near.ts" })).path).toBe(join(r.project, "near.ts"));
  });

  test("a reply from another project: an absolute link means that file; a relative one starts in the sender's project", async () => {
    const r = await referenced();
    writeFileSync(join(r.project, "app.ts"), "billing\n");
    const other = realpathSync(mkdtempSync(join(r.root, "other-")));
    writeFileSync(join(other, "app.ts"), "other\n");
    writeFileSync(join(other, "theirs.ts"), "other\n");
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const sent = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "Hello.", reply_to: r.thread, from_project: { name: "other", root: other } } as never);
    expect(sent.message.from_project?.root).toBe(other);
    const scope = { thread: sent.message.thread_id, message: sent.message.id };
    expect((await r.check({ ...scope, path: join(r.project, "app.ts") })).path).toBe(join(r.project, "app.ts"));
    expect((await r.check({ ...scope, path: join(other, "theirs.ts") })).path).toBe(join(other, "theirs.ts"));
    expect((await r.check({ ...scope, path: "app.ts" })).path).toBe(join(other, "app.ts"));
  });

  test("a message scope reads only its own thread: another thread's message brings no root", async () => {
    const r = await referenced();
    const elsewhere = realpathSync(mkdtempSync(join(r.root, "elsewhere-")));
    writeFileSync(join(elsewhere, ".git"), "gitdir: /x\n");
    writeFileSync(join(elsewhere, "secret.ts"), "there\n");
    const prj = r.server.store.ensureProject({ name: "billing", root: r.project });
    const stray = r.server.store.sendMessage({ project_id: prj.id, author: AGENT, body: "There.", base_path: elsewhere });
    // Without the thread rule, this message's folder would answer.
    expect((await r.check({ thread: stray.message.thread_id, message: stray.message.id, path: "secret.ts" })).found).toBe(true);
    expect(await r.check({ thread: r.thread, message: stray.message.id, path: "secret.ts" })).toEqual({ found: false });
    expect(await answerOf(await r.open({ thread: r.thread, message: stray.message.id, path: "secret.ts", app_id: "vscode" }))).toEqual([404, "attachment_missing"]);
  });

  test("only a whole, safe line number reaches the launcher", async () => {
    const r = await referenced();
    writeFileSync(join(r.project, "app.ts"), "export {};\n");
    const path = join(r.project, "app.ts");
    for (const line of ["12; rm -rf /", "12", 12.5, -1, 0, [12], {}, null, true, 1e24]) {
      r.launches.length = 0;
      await r.open({ thread: r.thread, path: "app.ts", app_id: "vscode", line });
      expect([line, r.launches]).toEqual([line, [{ how: "app", path, app: "vscode" }]]);
    }
  });

  test("only a regular file: a folder or a pipe has no control, and a read of one does not hang", async () => {
    const r = await referenced();
    mkdirSync(join(r.project, "folder.ts"));
    spawnSync("mkfifo", [join(r.project, "pipe.ts")]);
    expect(existsSync(join(r.project, "pipe.ts"))).toBe(true);
    for (const path of ["folder.ts", "pipe.ts"]) {
      expect(await r.check({ thread: r.thread, path })).toEqual({ found: false });
      expect(await answerOf(await r.open({ thread: r.thread, path, app_id: "vscode" }))).toEqual([404, "attachment_missing"]);
    }
    expect(r.launches).toEqual([]);
  });

  test("a read from another site is refused", async () => {
    const r = await referenced();
    writeFileSync(join(r.project, "app.ts"), "export {};\n");
    const answer = await fetch(`${r.base}${FILE}?thread=${r.thread}&path=app.ts`, { headers: { Origin: "https://evil.example" } });
    expect(answer.status).toBe(403);
  });

  test("a stale tab is turned away, and with Code review off the route answers nothing", async () => {
    const r = await referenced();
    expect(await answerOf(await r.open({ thread: r.thread, path: "plan.md", app_id: "vscode", serverSession: "stale" }))).toEqual([409, "session_mismatch"]);
    expect(r.launches).toEqual([]);
    const off = await referenced({ codeReview: false });
    expect(await answerOf(await fetch(`${off.base}${FILE}?thread=${off.thread}&path=plan.md`))).toEqual([409, "code_review_off"]);
    expect(await answerOf(await off.open({ thread: off.thread, path: "plan.md", app_id: "vscode" }))).toEqual([409, "code_review_off"]);
    expect(off.launches).toEqual([]);
  });
});

describe("Inbox Open in: the real launcher, with stubs on PATH", () => {
  const launchTest = process.platform === "win32" ? test.skip : test;
  launchTest("reveal and the default app run the platform's own launcher with the realpath, nothing else", async () => {
    const { root, dataDir, project } = world();
    const stubs = join(root, "stubs");
    mkdirSync(stubs);
    const log = join(stubs, "launches.log");
    for (const name of ["open", "xdg-open", "code", "explorer"]) {
      writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
      chmodSync(join(stubs, name), 0o755);
    }
    const server = await start(dataDir, { openInLauncher: systemOpenInLauncher() });
    const ids = await attach(server, project, ["shot.png", "build.zip"]);
    setEnv("PATH", stubs);
    expect(await (await openIn(server, { attachment_id: ids["shot.png"], app_id: "default" })).json()).toEqual({ ok: true });
    expect(await (await openIn(server, { attachment_id: ids["build.zip"], app_id: "reveal" })).json()).toEqual({ ok: true });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    if (process.platform === "darwin") {
      expect(lines).toEqual([`open ${join(project, "shot.png")}`, `open -R ${join(project, "build.zip")}`]);
    } else {
      expect(lines).toEqual([`xdg-open ${join(project, "shot.png")}`, `xdg-open ${project}`]);
    }
  });

  launchTest("a line goes in the URL of an app that has a scheme on macOS, to the CLI of one that takes it elsewhere; a path's spaces stay one argument", async () => {
    const { root } = world();
    const stubs = join(root, "stubs");
    mkdirSync(stubs);
    const log = join(stubs, "launches.log");
    for (const name of ["open", "code", "subl"]) {
      writeFileSync(join(stubs, name), `#!/bin/sh\nfor a in "$@"; do echo "${name}|$a" >> "${log}"; done\nexit 0\n`);
      chmodSync(join(stubs, name), 0o755);
    }
    setEnv("PATH", stubs);
    const code = getOpenInApp("vscode")!;
    const sublime = getOpenInApp("sublime-text")!;
    const file = "/work/my app/src/a#b.ts";
    expect(await openWithApp(code, file, 12)).toEqual({ ok: true });
    expect(await openWithApp(sublime, file, 12)).toEqual({ ok: true });
    expect(await openWithApp(code, file)).toEqual({ ok: true });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    if (process.platform === "darwin") {
      expect(lines).toEqual([
        "open|-a",
        "open|Visual Studio Code",
        "open|vscode://file/work/my%20app/src/a%23b.ts:12",
        // `open -a` takes no line: this one opens at the top.
        "open|-a",
        "open|Sublime Text",
        `open|${file}`,
        "open|-a",
        "open|Visual Studio Code",
        `open|${file}`,
      ]);
    } else {
      expect(lines).toEqual([`code|--goto`, `code|${file}:12`, `subl|${file}:12`, `code|${file}`]);
    }
  });
});

describe("Inbox Open in: the new-tab page", () => {
  test("now: a 303 to the page at its own folder's asset URL, served there with the attached-page sandbox; its images load from the folder", async () => {
    const { dataDir, project } = world();
    const server = await start(dataDir);
    const ids = await attach(server, project, ["page.html"]);
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${base}/api/inbox/attachments/${ids["page.html"]}/page`, { redirect: "manual" });
    expect(page.status).toBe(303);
    const location = page.headers.get("location")!;
    expect(location).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/page\.html$/);
    const served = await fetch(`${base}${location}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals; connect-src 'none'");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await served.text()).toContain("<h1 id=\"top\">Checkout</h1>");
    const image = await fetch(`${base}${location.replace("page.html", "shot.png")}`);
    expect(image.status).toBe(200);
    // A hidden file next to it is never served from the folder.
    expect((await fetch(`${base}${location.replace("page.html", ".draft.html")}`)).status).toBe(404);
  });

  test("the page cannot leave its sandbox by navigating its tab to a sibling SVG or XML: every non-HTML asset is sandboxed too", async () => {
    // Top-level, the response CSP is the page's only sandbox. A sibling .svg
    // (or XHTML .xml) opened as a document would otherwise run script on the
    // Inbox's origin and reach its API; it carries its own sandbox with no script.
    const { dataDir, project } = world();
    writeFileSync(join(project, "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/inbox/threads")</script></svg>');
    writeFileSync(join(project, "data.xml"), '<html xmlns="http://www.w3.org/1999/xhtml"><script>fetch("/api/inbox/threads")</script></html>');
    const server = await start(dataDir);
    const ids = await attach(server, project, ["page.html"]);
    const base = `http://127.0.0.1:${server.port}`;
    const location = (await fetch(`${base}/api/inbox/attachments/${ids["page.html"]}/page`, { redirect: "manual" })).headers.get("location")!;
    for (const name of ["chart.svg", "data.xml", "shot.png"]) {
      const asset = await fetch(`${base}${location.replace("page.html", name)}`, { headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-origin" } });
      expect([name, asset.status, asset.headers.get("content-security-policy")]).toEqual([
        name,
        200,
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      ]);
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("sent: the bytes the agent sent, with a <base href> at its folder, under the same sandbox", async () => {
    const { dataDir, project } = world();
    const server = await start(dataDir);
    const ids = await attach(server, project, ["page.html"]);
    writeFileSync(join(project, "page.html"), "<!doctype html><h1>Edited later</h1>\n");
    const sent = await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${ids["page.html"]}/page?version=sent`, { redirect: "manual" });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toContain("text/html");
    expect(sent.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals; connect-src 'none'");
    const html = await sent.text();
    expect(html).toContain("Checkout");
    expect(html).not.toContain("Edited later");
    expect(html).toMatch(/<base href="\/api\/html-assets\/[0-9a-f]{16}\/">/);
  });

  test("a hidden page is served directly; refusals: another site, not HTML, gone", async () => {
    const { dataDir, project } = world();
    const server = await start(dataDir);
    const ids = await attach(server, project, [".draft.html", "plan.md", "page.html"]);
    const base = `http://127.0.0.1:${server.port}`;
    const hidden = await fetch(`${base}/api/inbox/attachments/${ids[".draft.html"]}/page`, { redirect: "manual" });
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals; connect-src 'none'");
    expect(await hidden.text()).toContain("draft");
    const page = `${base}/api/inbox/attachments/${ids["page.html"]}/page`;
    expect(await answerOf(await fetch(page, { headers: { "Sec-Fetch-Site": "cross-site" } }))).toEqual([403, "cross_origin"]);
    expect(await answerOf(await fetch(`${base}/api/inbox/attachments/${ids["plan.md"]}/page`))).toEqual([415, "attachment_not_html"]);
    expect((await fetch(page, { method: "POST", body: "{}" })).status).toBe(405);
    unlinkSync(join(project, "page.html"));
    expect(await answerOf(await fetch(page, { redirect: "manual" }))).toEqual([404, "attachment_missing"]);
  });
});

describe("Inbox Open in: over the tailnet", () => {
  const MAGIC = "macbook-pro.tail0000.ts.net";
  const OWNER = "ramos@example.com";
  const tailscale: TailscaleRunner = (() => {
    const serve = new Map<number, string>();
    return (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
      if (args[1] === "status") {
        const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(serve.size === 0 ? "{}" : JSON.stringify({ TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])), Web }));
      }
      const port = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) serve.delete(port);
      else serve.set(port, args.at(-1)!);
      return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${port}/\n`);
    };
  })();

  test("the launch and the app list answer local_only; the owner opens the new-tab page", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac");
    const server = await start(dataDir, { openInLauncher: launcher, tailscale, publishTailnet: true, codeReview: true });
    const ids = await attach(server, project, ["plan.md", "page.html"]);
    const listener = server.tailscale.listenerPort()!;
    expect(listener).not.toBeNull();
    const through = (path: string, init: { method?: string; body?: string } = {}) =>
      fetch(`http://127.0.0.1:${listener}${path}`, {
        method: init.method ?? "GET",
        redirect: "manual",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, "Content-Type": "application/json", Origin: `https://${MAGIC}:${server.port}` },
        body: init.body,
      });
    expect(await answerOf(await through("/api/inbox/open-in/apps"))).toEqual([403, "local_only"]);
    expect(await answerOf(await through("/api/inbox/open-in", { method: "POST", body: JSON.stringify({ attachment_id: ids["plan.md"], app_id: "vscode" }) }))).toEqual([403, "local_only"]);
    // A file a reference names: the same, before anything else about it is read.
    const thread = "msg_any";
    expect(await answerOf(await through(`/api/inbox/open-in/file?thread=${thread}&path=plan.md`))).toEqual([403, "local_only"]);
    expect(await answerOf(await through("/api/inbox/open-in/file", { method: "POST", body: JSON.stringify({ thread, path: "plan.md", app_id: "vscode" }) }))).toEqual([403, "local_only"]);
    expect(launches).toEqual([]);
    const page = await through(`/api/inbox/attachments/${ids["page.html"]}/page`);
    expect(page.status).toBe(303);
    const served = await through(page.headers.get("location")!);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals; connect-src 'none'");
  });
});
