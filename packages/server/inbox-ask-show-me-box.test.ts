/**
 * A Show me from a dragged box, at the ask route: a stand-in Inbox store, a real Shape store in a temp folder, no
 * Inbox started. The window sends the box's picture as a data: URL and a request without the picture's line; the
 * route keeps the picture in the board's own folder and the request the agent reads names that file. What regresses
 * if these fail: the picture is dropped or kept outside the board, the agent is never told where it is, a box over
 * several parts goes out under one part's name, or the picture is kept again on a retry of the same turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxShowMeRequest, type InboxShowMeTarget } from "@plannotator/core/inbox-review";
import type { InboxThread } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createShapeStore } from "@plannotator/shared/shape/store";
import { createInboxAsk } from "./inbox-ask";

// A thread's id is its first message's.
const THREAD = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0A";
const SESSION = "srv_test";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const dirs: string[] = [];
const asks: ReturnType<typeof createInboxAsk>[] = [];
afterEach(() => {
  for (const ask of asks.splice(0)) ask.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-ask-box-"));
  dirs.push(dir);
  const shapes = createShapeStore({ dataDir: join(dir, "data") });
  const made = shapes.update({ board: { title: "Login", claim: "Built.", views: { picture: { html: '<p data-mark="a">A</p>' } } }, project: { root: dir, name: "app" }, session: null });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const board = made.id;
  const thread = { thread_id: THREAD, subject: "S", project: { name: "app", root: dir }, messages: [] } as unknown as InboxThread;
  // An owner whose client never connects: the turn is saved, and the answer is "no_connection".
  const store = {
    dir,
    onDeletion: () => () => {},
    thread: (id: string) => (id === THREAD ? thread : null),
    messageAnswerable: () => true,
    threadOwner: () => ({ session: "ses_owner", host: "claude-code" }),
  } as unknown as InboxStore;
  const ask = createInboxAsk({
    on: () => true,
    questionsOn: () => true,
    codeReviewOn: () => false,
    boardsOn: () => true,
    boardsOf: () => [{ id: board, versions: [] }],
    keepPicture: async (id, picture) => shapes.keepShowMePicture(id, picture),
    store,
    serverSession: SESSION,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    isGuest: () => false,
    onChange: () => {},
    token: "t",
    hostOf: () => "claude-code",
    times: { connectWaitMs: 10 },
  });
  asks.push(ask);
  const post = async (part: NonNullable<InboxShowMeTarget["part"]>, turn = "ask_01J8ZK3TQ4VW7Y9A2B5C6D8E0F") => {
    const target: InboxShowMeTarget = { review: null, file: null, lines: null, round: 1, words: "how does it fail", part };
    // As the window writes it: the picture is a data: URL, so the request has no picture line.
    const body = { serverSession: SESSION, turn_id: turn, question: inboxShowMeRequest({ target, title: "", threadId: THREAD }), kind: "show_me", show_me: target };
    const req = new Request(`http://127.0.0.1/api/inbox/threads/${THREAD}/ask`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const res = (await ask.route(req, new URL(req.url), "local"))!;
    return { status: res.status, body: (await res.json()) as { turn: { question: string; show_me: InboxShowMeTarget }; reason?: string } };
  };
  // The board's own folder (the store keeps each under its project's).
  const folder = join(shapes.dir, readdirSync(shapes.dir).find((project) => existsSync(join(shapes.dir, project, board)))!, board, "files");
  return { board, shapes, post, files: () => (existsSync(folder) ? readdirSync(folder) : []) };
}

describe("a Show me from a box", () => {
  test("over several parts: the parts named, the picture kept in the board's folder, and the request names its file", async () => {
    const { board, shapes, post, files } = setup();
    const { status, body } = await post({ board, name: "A part of the board", parts: ["Sign in", "Token store"], picture: `data:image/png;base64,${PNG}` });
    expect(status).toBe(200);
    expect(files()).toHaveLength(1);
    const path = shapes.filePath(board, files()[0]!)!;
    expect(readFileSync(path).equals(Buffer.from(PNG, "base64"))).toBe(true);
    expect(body.turn.show_me.part?.picture).toBe(path);
    const lines = body.turn.question.split("\n");
    expect(lines[0]).toBe(`The person pressed Show me on "A part of the board" (parts: Sign in, Token store) in your Shape ${board}: "how does it fail".`);
    expect(lines[1]).toBe(`A picture of what they boxed, the box drawn on it: ${path}.`);
    expect(lines[2]).toStartWith("Make a new Shape of that part");
  });

  test("over one part: its own name and code, no list of parts, and the picture's line", async () => {
    const { board, post, files } = setup();
    const { body } = await post({ board, name: "Token store", code: "src/token.ts#L4-L9", picture: `data:image/png;base64,${PNG}` });
    const lines = body.turn.question.split("\n");
    expect(lines[0]).toBe(`The person pressed Show me on "Token store" (src/token.ts#L4-L9) in your Shape ${board}: "how does it fail".`);
    expect(lines[1]).toStartWith("A picture of what they boxed, the box drawn on it: ");
    expect(files()).toHaveLength(1);
  });

  test("a retry of the same turn keeps no second picture, and a part with no box has no picture line", async () => {
    const { board, post, files } = setup();
    const first = await post({ board, name: "A part of the board", parts: ["Sign in", "Token store"], picture: `data:image/png;base64,${PNG}` });
    const again = await post({ board, name: "A part of the board", parts: ["Sign in", "Token store"], picture: `data:image/png;base64,${PNG}` });
    expect(again.body.turn.question).toBe(first.body.turn.question);
    expect(files()).toHaveLength(1);
    const plain = await post({ board, name: "Sign in" }, "ask_01J8ZK3TQ4VW7Y9A2B5C6D8E0G");
    expect(plain.body.turn.question).not.toContain("A picture of what they boxed");
  });
});
