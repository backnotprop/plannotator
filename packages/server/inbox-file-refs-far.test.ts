/**
 * A file a message names, asked for by a linked machine through the device door (approval
 * "inbox-file-refs-open-viewer"; one experience across the person's devices): the view, raw and attach routes of
 * packages/server/inbox-open-in.ts, called on the route itself with a scratch store and a stand-in door. Only a press in
 * a window there is taken, and it reaches a path the message names or a file in the thread's project, nothing else.
 * No Inbox starts; every file is a fixture under a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { createInboxOpenInRoute, type InboxOpenInLauncher } from "./inbox-open-in";

type Json = Record<string, any>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a1b00000000049454e44ae426082", "hex");
const nothing = async (): Promise<never> => {
  throw new Error("nothing launches here");
};
const launcher: InboxOpenInLauncher = { platform: "darwin", apps: () => [], reveal: nothing, openWithApp: nothing, openWithSystemDefault: nothing };
const SESSION = "srv-session";

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-refs-far-")));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  for (const dir of [join(home, "notes"), join(project, "docs"), join(project, "src"), elsewhere]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "docs", "plan.md"), "# Plan\n");
  writeFileSync(join(project, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(elsewhere, "named.log"), "named\n");
  writeFileSync(join(elsewhere, "named.lo"), "a prefix\n");
  writeFileSync(join(elsewhere, "other.md"), "# Not named\n");
  writeFileSync(join(elsewhere, "shot.png"), PNG);
  writeFileSync(join(home, "notes", "todo.md"), "- one\n");
  symlinkSync(join(elsewhere, "other.md"), join(project, "docs", "link.md"));

  const store = InboxStore.open(join(root, "data"));
  const prj = store.ensureProject({ name: "project", root: project });
  const body = `The plan is \`docs/plan.md\`; the run wrote ${join(elsewhere, "named.log")}.`;
  const { message } = store.sendMessage({ project_id: prj.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body });
  let door: { window: boolean } | null = null;
  const route = createInboxOpenInRoute({
    store,
    serverSession: SESSION,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (json, status = 200) => Response.json(json, { status }),
    localOnly: () => Response.json({ code: "local_only" }, { status: 403 }),
    launcher,
    codeReviewOn: () => false,
    shapeRoot: () => null,
    repoRoots: () => [],
    threadPulls: () => [],
    pullFile: async () => null,
    home,
    doorOf: () => door,
  });
  const call = async (req: Request): Promise<{ status: number; body: Json }> => {
    try {
      const response = (await route(req, new URL(req.url).pathname, "local"))!;
      return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? ((await response.json()) as Json) : {} };
    } catch (error) {
      if (error instanceof InboxError) return { status: 400, body: { code: error.code, error: error.message } };
      throw error;
    }
  };
  const query = (path: string, in_ = message.id) => new URLSearchParams({ thread: message.thread_id, message: in_, path });
  return {
    project,
    elsewhere,
    store,
    message,
    /** `from`: this computer's window (null), or a linked machine's call (`window`: a press in a window there). */
    as(from: { window: boolean } | null) {
      door = from;
      return this;
    },
    view: (path: string, in_?: string) => call(new Request(`http://127.0.0.1/api/inbox/open-in/file/view?${query(path, in_)}`)),
    raw: (path: string, in_?: string) => call(new Request(`http://127.0.0.1/api/inbox/open-in/file/raw?${query(path, in_)}`)),
    attach: (path: string, in_ = message.id) =>
      call(
        new Request("http://127.0.0.1/api/inbox/open-in/file/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread: message.thread_id, message: in_, path, serverSession: SESSION }),
        }),
      ),
    attachments: () => store.message(message.id)?.attachments ?? [],
  };
}

describe("a file a message names, asked for by a linked machine", () => {
  test("a call that is not a press in a window there is refused on the view, the bytes and the attach", async () => {
    const w = world().as({ window: false });
    for (const answer of [await w.view("docs/plan.md"), await w.raw(join(w.elsewhere, "shot.png")), await w.attach("docs/plan.md")]) {
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ error: "A file on another machine opens from the Inbox window only.", code: "window_only" });
    }
    expect(w.attachments()).toEqual([]);
  });

  test("from a window there: a path the message names opens, inside the project or not, and attaches", async () => {
    const w = world().as({ window: true });
    expect((await w.view("docs/plan.md")).body).toMatchObject({ found: true, contents: "# Plan\n" });
    expect((await w.view(join(w.elsewhere, "named.log"))).body).toMatchObject({ found: true, contents: "named\n" });
    const attached = await w.attach("docs/plan.md");
    expect(attached.status).toBe(200);
    expect(w.attachments().map((a) => a.name)).toEqual(["plan.md"]);
  });

  test("a path the message does not name: a file in the thread's project opens; out of it, by any road, is not on this computer", async () => {
    const w = world().as({ window: true });
    expect((await w.view("src/app.ts")).body).toMatchObject({ found: true, contents: "export const app = 1;\n" });
    for (const path of [join(w.elsewhere, "other.md"), "~/notes/todo.md", "../elsewhere/other.md", "docs/../../elsewhere/other.md", "docs/link.md"]) {
      expect({ asked: path, ...(await w.view(path)).body }).toMatchObject({ asked: path, found: false, reason: "missing" });
    }
    expect((await w.raw(join(w.elsewhere, "shot.png"))).status).toBe(404);
    const refused = await w.attach("../elsewhere/other.md");
    expect(refused.body).toEqual({ code: "attachment_missing", error: "../elsewhere/other.md is not on this computer." });
    expect(w.attachments()).toEqual([]);
  });

  test("part of a named path names nothing: `named.lo` is not named by `named.log`", async () => {
    const w = world().as({ window: true });
    expect((await w.view(join(w.elsewhere, "named.lo"))).body).toMatchObject({ found: false, reason: "missing" });
    expect((await w.as(null).view(join(w.elsewhere, "named.lo"))).body).toMatchObject({ found: true, contents: "a prefix\n" });
  });

  test("a path named only in the person's own reply (one a linked machine may post) is not on this computer", async () => {
    const w = world().as({ window: true });
    const outside = join(w.elsewhere, "other.md");
    const { reply } = w.store.sendReply(w.message.id, { words: `look at ${outside} and ${join(w.elsewhere, "shot.png")}`, idempotency_key: "k1" });
    expect((await w.view(outside, reply.id)).body).toMatchObject({ found: false, reason: "missing" });
    expect((await w.raw(join(w.elsewhere, "shot.png"), reply.id)).status).toBe(404);
    expect((await w.attach(outside, reply.id)).status).toBe(400);
    expect(w.attachments()).toEqual([]);
  });

  test("this computer's own window still opens a file anywhere but a secret", async () => {
    const w = world().as(null);
    expect((await w.view(join(w.elsewhere, "other.md"))).body).toMatchObject({ found: true, contents: "# Not named\n" });
    expect((await w.view("~/notes/todo.md")).body).toMatchObject({ found: true, contents: "- one\n" });
    expect((await w.raw(join(w.elsewhere, "shot.png"))).status).toBe(200);
  });
});
