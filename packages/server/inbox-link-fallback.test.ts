/**
 * A relative link in an agent's message that is not where that message's own folder says. The folder a message keeps
 * (`base_path`) follows the agent's shell, so two messages of one thread can start the same link text in two folders.
 * The referenced-file view (inbox-open-in.ts) then opens the file the person means: an attachment of that name in the
 * message, else the newest one the same sender (same session, same computer) attached earlier in the thread, else the
 * link from the folders that sender wrote from before (never another checkout's from a linked worktree). The pane's
 * view, its raw bytes, a comment's attach, the hover and Open in all take that one order. A file found nowhere says
 * where it was looked for, and never hands a linked machine a path it could not see. Nothing it may not read before
 * opens now. And send_message names each link that opens nothing (`links_not_found`), asking the thread's PR first.
 *
 * What regresses if this fails: the person clicks a link to a file the thread already holds and is told it is not
 * on this computer; or a link that opens nothing reaches the person with no word to the agent; or the fallback reads
 * a secret or, for a linked machine, a folder out of the thread.
 *
 * A real store in a temp data dir and the route called directly; no Inbox server, no network, never the real home.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { createInboxOpenInRoute, type InboxLinkPulls, type InboxOpenInLauncher } from "./inbox-open-in";
import { bodyFileLinks, linksNotFound, linksNotFoundText } from "./inbox-links-not-found";
import { sendAgentMessage, type InboxMcpContext } from "./inbox-mcp";

type Json = Record<string, any>;

const roots: string[] = [];
let savedDataDir: string | undefined;
beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const launcher: InboxOpenInLauncher = {
  platform: "darwin",
  apps: () => [],
  reveal: async () => ({ ok: false }) as never,
  openWithApp: async () => ({ ok: false }) as never,
  openWithSystemDefault: async () => ({ ok: false }) as never,
};

const CHARLIE = { kind: "agent" as const, host: "claude-code", session: "ses_charlie", name: "Charlie Dunn" };
const BOB = { kind: "agent" as const, host: "codex", session: "ses_bob", name: "Bob Tully" };

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a1b00000000049454e44ae426082", "hex");

type Pulls = InboxLinkPulls;

function world(options: { door?: boolean; pulls?: Pulls } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-link-fallback-")));
  roots.push(root);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  const home = join(root, "home");
  const harbor = join(root, "harbor");
  const elsewhere = join(root, "elsewhere");
  // A linked worktree of harbor: its `.git` is a file naming a folder that exists.
  const worktree = join(root, "harbor-wt");
  for (const dir of [home, join(harbor, ".git", "worktrees", "wt"), join(harbor, "review", "build", "deep"), join(harbor, "docs"), join(harbor, "notes"), join(worktree, "docs"), join(worktree, "review"), elsewhere]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(harbor, ".git", "worktrees", "wt")}\n`);
  writeFileSync(join(harbor, "docs", "shot.png"), PNG);
  writeFileSync(join(harbor, "docs", "spec.md"), "# Spec, main checkout\n");
  writeFileSync(join(harbor, "review", "decisions.html"), "<!doctype html><h1>Decisions</h1>\n");
  writeFileSync(join(harbor, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(harbor, "docs", ".env"), "TOKEN=secret\n");
  writeFileSync(join(harbor, "notes", "plan.md"), "# Plan\n");
  writeFileSync(join(harbor, "notes", "decisions.html"), "<!doctype html><h1>Draft</h1>\n");
  writeFileSync(join(elsewhere, "far.md"), "# Far\n");
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "harbor", root: harbor });
  const route = createInboxOpenInRoute({
    store,
    serverSession: "srv",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    localOnly: () => Response.json({ code: "local_only" }, { status: 403 }),
    launcher,
    codeReviewOn: () => true,
    shapeRoot: () => null,
    repoRoots: () => [],
    threadPulls: options.pulls?.threadPulls ?? (() => []),
    pullFile: options.pulls?.pullFile ?? (async () => null),
    home,
    ...(options.door ? { doorOf: () => ({ window: true }) } : {}),
  } as Parameters<typeof createInboxOpenInRoute>[0]);
  const attach = async (paths: string[], base: string) => recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() });
  const say = async (body: string, extra: { base?: string; attach?: string[]; reply_to?: string; author?: Record<string, unknown> } = {}) =>
    store.sendMessage({
      project_id: project.id,
      author: (extra.author ?? CHARLIE) as typeof CHARLIE,
      body,
      ...(extra.reply_to ? { reply_to: extra.reply_to } : {}),
      ...(extra.base ? { base_path: extra.base } : {}),
      ...(extra.attach ? { attachments: await attach(extra.attach, extra.base ?? harbor) } : {}),
    }).message;
  type At = { id: string; thread_id: string };
  const call = async (req: Request): Promise<Response> => {
    try {
      return (await route(req, new URL(req.url).pathname, "local"))!;
    } catch (error) {
      if (error instanceof InboxError) return Response.json({ code: error.code, error: error.message }, { status: 400 });
      throw error;
    }
  };
  const query = (message: At, path: string) => new URLSearchParams({ thread: message.thread_id, message: message.id, path });
  const view = async (message: At, path: string): Promise<Json> => (await (await call(new Request(`http://127.0.0.1/api/inbox/open-in/file/view?${query(message, path)}`))).json()) as Json;
  const raw = (message: At, path: string) => call(new Request(`http://127.0.0.1/api/inbox/open-in/file/raw?${query(message, path)}`));
  /** The hover's check (Open in, Copy path): `GET /open-in/file`. */
  const hover = async (message: At, path: string): Promise<Json> => (await (await call(new Request(`http://127.0.0.1/api/inbox/open-in/file?${query(message, path)}`))).json()) as Json;
  const post = async (url: string, body: Json): Promise<Json> =>
    (await (await call(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "srv", ...body }) }))).json()) as Json;
  /** A comment's attach (the annotate route). */
  const attachRef = (message: At, path: string) => post("http://127.0.0.1/api/inbox/open-in/file/attach", { thread: message.thread_id, message: message.id, path });
  /** Open in's launch. */
  const openIn = (message: At, path: string) => post("http://127.0.0.1/api/inbox/open-in/file", { thread: message.thread_id, message: message.id, path, app_id: "default" });
  return { root, home, harbor, worktree, elsewhere, store, project, say, view, raw, hover, attachRef, openIn };
}

test("a link that misses its own folder opens the newest same-named file the same sender attached earlier in the thread", async () => {
  const w = world();
  const first = await w.say("A first draft of the decisions, attached.", { base: join(w.harbor, "notes"), attach: ["decisions.html"] });
  const second = await w.say("The 22 decisions, attached.", { base: join(w.harbor, "review"), reply_to: first.id, attach: ["decisions.html"] });
  const later = await w.say("Read [the decisions](decisions.html) first.", { base: join(w.harbor, "review", "build"), reply_to: first.id });
  expect(await w.view(later, "decisions.html")).toMatchObject({ found: true, attachment_id: second.attachments![0]!.id });
  // The first message, read on its own, opens its own copy.
  expect(await w.view(first, "decisions.html")).toMatchObject({ found: true, attachment_id: first.attachments![0]!.id });
});

test("its own message's attachment of that name comes before an earlier message's", async () => {
  const w = world();
  const first = await w.say("Attached.", { base: join(w.harbor, "review"), attach: ["decisions.html"] });
  const own = await w.say("Again, see [decisions](decisions.html).", { base: join(w.harbor, "review", "build"), reply_to: first.id, attach: [join(w.harbor, "review", "decisions.html")] });
  expect(await w.view(own, "decisions.html")).toMatchObject({ found: true, attachment_id: own.attachments![0]!.id });
});

test("from the project folder, and from a folder the same sender wrote from earlier in the thread; never another sender's", async () => {
  const w = world();
  const first = await w.say("Started in docs.", { base: join(w.harbor, "docs") });
  const later = await w.say("See [the plan](notes/plan.md) and [the guide](guide.md).", { base: join(w.harbor, "review", "build"), reply_to: first.id });
  expect(await w.view(later, "notes/plan.md")).toMatchObject({ found: true, contents: "# Plan\n" });
  expect(await w.view(later, "guide.md")).toMatchObject({ found: true, contents: "# Guide\n" });
  const bob = await w.say("And [the guide](guide.md).", { base: join(w.harbor, "review", "build"), reply_to: first.id, author: BOB });
  expect(await w.view(bob, "guide.md")).toMatchObject({ found: false, reason: "missing" });
});

test("a file found nowhere is missing, with where it was looked for first, from the project folder", async () => {
  const w = world();
  const message = await w.say("See [gone](gone.html).", { base: join(w.harbor, "review", "build") });
  expect(await w.view(message, "gone.html")).toEqual({ found: false, name: "gone.html", path: "gone.html", reason: "missing", looked_in: "review/build/gone.html" });
});

test("no widening: a secret in an earlier folder stays unread, and a linked machine's earlier folder out of the thread is not used", async () => {
  const w = world();
  const first = await w.say("Started in docs.", { base: join(w.harbor, "docs") });
  const later = await w.say("The [settings](.env).", { base: join(w.harbor, "review", "build"), reply_to: first.id });
  const secret = await w.view(later, ".env");
  expect([secret.found, secret.contents]).toEqual([false, undefined]);

  const d = world({ door: true });
  const out = await d.say("Started out of the project.", { base: d.elsewhere });
  const named = await d.say("See [far](far.md).", { base: join(d.harbor, "review", "build"), reply_to: out.id });
  expect(await d.view(named, "far.md")).toMatchObject({ found: false, reason: "missing" });
  // On this computer's own window the same link opens: the sender's earlier folder.
  const local = world();
  const localOut = await local.say("Started out of the project.", { base: local.elsewhere });
  const localNamed = await local.say("See [far](far.md).", { base: join(local.harbor, "review", "build"), reply_to: localOut.id });
  expect(await local.view(localNamed, "far.md")).toMatchObject({ found: true, contents: "# Far\n" });
});

test("the body's file links: markdown links outside code, never images, web links, anchors or folders", () => {
  const body = [
    "[a](decisions.html) ![pic](shot.png) [web](https://example.com/x.html) [top](#top) [dir](src/)",
    "[line](src/app.ts:12) [enc](my%20notes.md?x=1#y) `[code](inside.md)`",
    "```",
    "[fenced](fenced.md)",
    "```",
  ].join("\n");
  expect(bodyFileLinks(body).map((link) => link.path)).toEqual(["decisions.html", "src/app.ts", "my notes.md"]);
});

test("send_message: links_not_found names a link that opens nothing and where it looked; nothing for a good link or one the thread holds", async () => {
  const w = world();
  const context = {
    store: w.store,
    baseUrl: () => "http://localhost:1/",
    recordAttachments: (paths: readonly string[], _project: unknown, base: string) => recordInboxAttachments(w.store.dir, paths, { base, at: new Date().toISOString() }),
  } as unknown as InboxMcpContext;
  const first = await sendAgentMessage(context, w.project, {
    body: "The decisions, attached.",
    project_path: join(w.harbor, "review"),
    attachments: ["decisions.html"],
    agent_session: "ses_charlie",
  } as never);
  expect(first.structured.links_not_found).toBeUndefined();
  const sent = await sendAgentMessage(context, w.project, {
    body: "Read [decisions](decisions.html), [the plan](notes/plan.md) and [the summary](summary.html).",
    project_path: join(w.harbor, "review", "build"),
    reply_to: String(first.structured.message_id),
    agent_session: "ses_charlie",
  } as never);
  expect(sent.structured.links_not_found).toEqual([{ ref: "summary.html", path: join(w.harbor, "review", "build", "summary.html") }]);
  expect(linksNotFoundText(sent.linksNotFound)).toContain("summary.html");
  const store = w.store;
  expect(await linksNotFound(store, { id: String(first.structured.message_id), thread_id: String(first.structured.thread_id), body: "[ok](decisions.html)" })).toEqual([]);
});

test("two files of one name from two senders: the linking sender's opens; the person's upload never does", async () => {
  const w = world();
  const charlie = await w.say("The page, attached.", { base: join(w.harbor, "notes"), attach: ["decisions.html"] });
  // Bob's copy of the same name comes later, so newest-first over every author would pick it.
  const bob = await w.say("Mine, attached.", { base: join(w.harbor, "review"), reply_to: charlie.id, attach: ["decisions.html"], author: BOB });
  const later = await w.say("Read [the decisions](decisions.html).", { base: join(w.harbor, "review", "build"), reply_to: charlie.id });
  expect(await w.view(later, "decisions.html")).toMatchObject({ found: true, attachment_id: charlie.attachments![0]!.id });
  const fromBob = await w.say("Read [mine](decisions.html).", { base: join(w.harbor, "review", "build"), reply_to: charlie.id, author: BOB });
  expect(await w.view(fromBob, "decisions.html")).toMatchObject({ found: true, attachment_id: bob.attachments![0]!.id });

  const p = world();
  writeFileSync(join(p.elsewhere, "notes.md"), "# The person's notes\n");
  const asked = await p.say("Started.", { base: join(p.harbor, "review", "build") });
  await p.say("My notes.", { base: p.elsewhere, reply_to: asked.id, attach: [join(p.elsewhere, "notes.md")], author: { kind: "person" } });
  const linking = await p.say("See [the notes](notes.md).", { base: join(p.harbor, "review", "build"), reply_to: asked.id });
  expect(await p.view(linking, "notes.md")).toMatchObject({ found: false, reason: "missing" });
});

test("the same sender's earlier attachment comes before its earlier folder", async () => {
  const w = world();
  const first = await w.say("From notes, with the review's page attached.", { base: join(w.harbor, "notes"), attach: [join(w.harbor, "review", "decisions.html")] });
  const later = await w.say("Read [it](decisions.html).", { base: join(w.harbor, "review", "build"), reply_to: first.id });
  // harbor/notes/decisions.html is on disk too: the attachment still wins.
  expect(await w.view(later, "decisions.html")).toMatchObject({ found: true, attachment_id: first.attachments![0]!.id });
});

test("a session on another computer never picks up a local agent's attachment or folder, even with the same session id", async () => {
  const w = world();
  const local = await w.say("Attached, and written from docs.", { base: join(w.harbor, "docs"), attach: ["guide.md"] });
  const far = await w.say("See [the guide](guide.md).", { base: join(w.harbor, "review", "build"), reply_to: local.id, author: { ...CHARLIE, machine: "ibx_far", machine_name: "Studio" } });
  expect(await w.view(far, "guide.md")).toMatchObject({ found: false, reason: "missing" });
  // The same message from this computer's session opens it.
  const near = await w.say("See [the guide](guide.md).", { base: join(w.harbor, "review", "build"), reply_to: local.id });
  expect(await w.view(near, "guide.md")).toMatchObject({ found: true, attachment_id: local.attachments![0]!.id });
});

test("an agent in a linked worktree never falls back to the main checkout's folder: view, raw and annotate", async () => {
  const w = world();
  const main = await w.say("Written from the main checkout.", { base: join(w.harbor, "docs") });
  const inWorktree = await w.say("See [the spec](spec.md) and ![shot](shot.png).", { base: join(w.worktree, "review"), reply_to: main.id });
  expect(await w.view(inWorktree, "spec.md")).toMatchObject({ found: false, reason: "missing" });
  expect((await w.raw(inWorktree, "shot.png")).status).toBe(404);
  expect(await w.attachRef(inWorktree, "spec.md")).toMatchObject({ code: "attachment_missing" });
  // Its own earlier folder in the same worktree still counts.
  writeFileSync(join(w.worktree, "docs", "spec.md"), "# Spec, worktree\n");
  const there = await w.say("Written from the worktree's docs.", { base: join(w.worktree, "docs"), reply_to: main.id });
  const after = await w.say("See [the spec](spec.md).", { base: join(w.worktree, "review"), reply_to: there.id });
  expect(await w.view(after, "spec.md")).toMatchObject({ found: true, contents: "# Spec, worktree\n" });
});

test("raw and annotate take the same fallback as the view: the sender's earlier folder", async () => {
  const w = world();
  const first = await w.say("Started in docs.", { base: join(w.harbor, "docs") });
  const later = await w.say("See ![shot](shot.png) and [the spec](spec.md).", { base: join(w.harbor, "review", "build"), reply_to: first.id });
  const png = await w.raw(later, "shot.png");
  expect(png.status).toBe(200);
  expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
  const attached = await w.attachRef(later, "spec.md");
  expect(attached.attachment).toMatchObject({ name: "spec.md", path: join(w.harbor, "docs", "spec.md") });
});

test("a ../ link resolves from the sender's earlier folder, in the view and in the hover", async () => {
  const w = world();
  const first = await w.say("Started in review.", { base: join(w.harbor, "review") });
  const later = await w.say("See [the plan](../notes/plan.md).", { base: join(w.harbor, "review", "build", "deep"), reply_to: first.id });
  expect(await w.view(later, "../notes/plan.md")).toMatchObject({ found: true, contents: "# Plan\n" });
  expect(await w.hover(later, "../notes/plan.md")).toMatchObject({ found: true, path: join(w.harbor, "notes", "plan.md") });
});

test("the hover and Open in take the fallback too; a file found nowhere is never said to be 'not on this computer'", async () => {
  const w = world();
  const first = await w.say("Started in docs, the guide attached.", { base: join(w.harbor, "docs"), attach: ["guide.md"] });
  const later = await w.say("See [the guide](guide.md) and [the spec](spec.md).", { base: join(w.harbor, "review", "build"), reply_to: first.id });
  expect(await w.hover(later, "guide.md")).toMatchObject({ found: true, path: join(w.harbor, "docs", "guide.md") });
  expect(await w.hover(later, "spec.md")).toMatchObject({ found: true, path: join(w.harbor, "docs", "spec.md") });
  const gone = await w.openIn(later, "gone.md");
  expect(gone.code).toBe("attachment_missing");
  expect(gone.error).not.toContain("not on this computer");
  expect(gone.error).toContain("review/build/gone.md");
  const annotate = await w.attachRef(later, "gone.md");
  expect(annotate.code).toBe("attachment_missing");
  expect(annotate.error).not.toContain("not on this computer");
});

test("a file linked at the project's top names no path that is only its name; a linked machine is never handed a path out of the project", async () => {
  const w = world();
  const top = await w.say("See [the plan](plan.md).", { base: w.harbor });
  expect(await w.view(top, "plan.md")).toMatchObject({ found: false, looked_in: "plan.md" });
  expect((await w.attachRef(top, "plan.md")).error).toBe("Couldn't find plan.md.");
  const deep = await w.say("See [the plan](gone.md).", { base: join(w.harbor, "review"), reply_to: top.id });
  expect((await w.attachRef(deep, "gone.md")).error).toBe("gone.md isn't at review/gone.md.");

  const d = world({ door: true });
  const home = await d.say("See [todo](~/todo.md) and [gone](gone.md).", { base: join(d.harbor, "review") });
  const homeAnswer = await d.view(home, "~/todo.md");
  expect(homeAnswer).toMatchObject({ found: false, reason: "missing" });
  expect(homeAnswer.looked_in).toBeUndefined();
  // In the project, the same path it can already see.
  expect(await d.view(home, "gone.md")).toMatchObject({ found: false, looked_in: "review/gone.md" });
  // This computer's own window is told where in its own home it looked.
  const l = world();
  const own = await l.say("See [todo](~/todo.md).", { base: join(l.harbor, "review") });
  expect((await l.view(own, "~/todo.md")).looked_in).toBe(join(l.home, "todo.md"));
});

test("links_not_found asks the thread's PR first, as the view does: a link only the PR holds is not warned of", async () => {
  const pulls: Pulls = {
    threadPulls: () => ["github.com/o/harbor#7"],
    pullFile: async (_pull, path) => (path === "docs/only-in-pr.md" ? { contents: "# In the PR\n", label: "#7", platform: "github", url: "https://github.com/o/harbor/pull/7" } : null),
  };
  const w = world({ pulls });
  const message = await w.say("See [the change](docs/only-in-pr.md) and [gone](docs/gone.md).", { base: w.harbor });
  expect(await w.view(message, "docs/only-in-pr.md")).toMatchObject({ found: true, contents: "# In the PR\n" });
  const warned = await linksNotFound(w.store, message, w.home, pulls);
  expect(warned.map((link) => link.ref)).toEqual(["docs/gone.md"]);
});
