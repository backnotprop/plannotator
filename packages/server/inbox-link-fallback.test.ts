/**
 * A relative link in an agent's message that is not where that message's own folder says. The folder a message keeps
 * (`base_path`) follows the agent's shell, so two messages of one thread can start the same link text in two folders.
 * The referenced-file view (inbox-open-in.ts) then opens the file the person means: an attachment of that name in the
 * message, else the newest one an earlier message of the thread attached, else the link from the folders the same
 * sender wrote from before. A file found nowhere says where it was looked for. Nothing it may not read before opens
 * now. And send_message names each link that opens nothing (`links_not_found`).
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
import { createInboxOpenInRoute, type InboxOpenInLauncher } from "./inbox-open-in";
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

function world(options: { door?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-link-fallback-")));
  roots.push(root);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  const home = join(root, "home");
  const harbor = join(root, "harbor");
  const elsewhere = join(root, "elsewhere");
  for (const dir of [home, join(harbor, ".git"), join(harbor, "review", "build"), join(harbor, "docs"), join(harbor, "notes"), elsewhere]) mkdirSync(dir, { recursive: true });
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
    codeReviewOn: () => false,
    shapeRoot: () => null,
    repoRoots: () => [],
    threadPulls: () => [],
    pullFile: async () => null,
    home,
    ...(options.door ? { doorOf: () => ({ window: true }) } : {}),
  } as Parameters<typeof createInboxOpenInRoute>[0]);
  const attach = async (paths: string[], base: string) => recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() });
  const say = async (body: string, extra: { base?: string; attach?: string[]; reply_to?: string; author?: typeof CHARLIE } = {}) =>
    store.sendMessage({
      project_id: project.id,
      author: extra.author ?? CHARLIE,
      body,
      ...(extra.reply_to ? { reply_to: extra.reply_to } : {}),
      ...(extra.base ? { base_path: extra.base } : {}),
      ...(extra.attach ? { attachments: await attach(extra.attach, extra.base ?? harbor) } : {}),
    }).message;
  const view = async (message: { id: string; thread_id: string }, path: string): Promise<Json> => {
    const query = new URLSearchParams({ thread: message.thread_id, message: message.id, path });
    const req = new Request(`http://127.0.0.1/api/inbox/open-in/file/view?${query}`);
    try {
      return (await (await route(req, "/api/inbox/open-in/file/view", "local"))!.json()) as Json;
    } catch (error) {
      if (error instanceof InboxError) return { code: error.code };
      throw error;
    }
  };
  return { root, home, harbor, elsewhere, store, project, say, view };
}

test("a link that misses its own folder opens the newest same-named file an earlier message of the thread attached", async () => {
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
