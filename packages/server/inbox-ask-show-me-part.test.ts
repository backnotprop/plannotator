/**
 * The ask route's gates for a Show me from a board, on the route alone: a stand-in store, no Inbox started. Each
 * request is the window's exact request (`inboxShowMeRequest`), so the question check passes and the gate under test
 * is the only thing that can refuse it. What regresses if these fail: a Show me goes out on another thread's board,
 * or on a board while Shape and Code review are both off (PLANNOTATOR_INBOX_ASK_AI turns the route on by itself).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxShowMeRequest, type InboxShowMeTarget } from "@plannotator/core/inbox-review";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxAsk } from "./inbox-ask";

const THREAD = "thr_01J8ZK3TQ4VW7Y9A2B5C6D8E0A";
const OTHER = "thr_01J8ZK3TQ4VW7Y9A2B5C6D8E0B";
const BOARD = "shp_01J8ZK3TQ4VW7Y9A2B5C6D8E0C";
const OTHER_BOARD = "shp_01J8ZK3TQ4VW7Y9A2B5C6D8E0D";
const SESSION = "srv_test";

const dirs: string[] = [];
const asks: ReturnType<typeof createInboxAsk>[] = [];
afterEach(() => {
  for (const ask of asks.splice(0)) ask.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function route(switches: { codeReview: boolean; boards: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-ask-part-"));
  dirs.push(dir);
  const thread = (id: string) => ({ thread_id: id, subject: "S", project: { name: "p", root: dir }, messages: [] }) as unknown as InboxThread;
  // No owner: a request the gates let through ends at "No agent owns this thread", with nothing saved.
  const store = { dir, onDeletion: () => () => {}, thread: (id: string) => (id === THREAD || id === OTHER ? thread(id) : null), messageAnswerable: () => true, threadOwner: () => null } as unknown as InboxStore;
  const ask = createInboxAsk({
    codeReviewOn: () => switches.codeReview,
    boardsOn: () => switches.boards,
    boardsOf: (threadId) => [{ id: threadId === THREAD ? BOARD : OTHER_BOARD, versions: [] }],
    store,
    serverSession: SESSION,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    token: "t",
    hostOf: () => null,
  });
  asks.push(ask);
  return async (board: string): Promise<{ status: number; code?: string; message?: string }> => {
    const target: InboxShowMeTarget = { review: null, file: null, lines: null, round: 1, part: { board, name: "The next attempt" } };
    const body = { serverSession: SESSION, turn_id: "ask_01J8ZK3TQ4VW7Y9A2B5C6D8E0F", question: inboxShowMeRequest({ target, title: "", threadId: THREAD }), kind: "show_me", show_me: target };
    const req = new Request(`http://127.0.0.1/api/inbox/threads/${THREAD}/ask`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const res = (await ask.route(req, new URL(req.url), "local"))!;
      const answer = (await res.json()) as { code?: string };
      return { status: res.status, code: answer.code };
    } catch (error) {
      if (error instanceof InboxError) return { status: 0, code: error.code, message: error.message };
      throw error;
    }
  };
}

describe("a Show me from a board, at the ask route", () => {
  test("on a board of this thread, with the boards on, it passes every gate (and stops only for want of an owner)", async () => {
    expect(await (route({ codeReview: false, boards: true }))(BOARD)).toMatchObject({ code: "ask_no_owner" });
  });

  test("on another thread's board, with its exact request, it is refused as not a board of this thread", async () => {
    const refused = await (route({ codeReview: true, boards: true }))(OTHER_BOARD);
    expect(refused.code).toBe("validation_error");
    expect(refused.message).toContain(`${OTHER_BOARD} is not a board of this thread`);
  });

  test("with Shape and Code review both off it is refused", async () => {
    expect(await (route({ codeReview: false, boards: false }))(BOARD)).toEqual({ status: 409, code: "code_review_off" });
  });

  test("with Code review on and Shape off it is refused: Code review brings no boards (approval code-review-029-shape-off)", async () => {
    expect(await (route({ codeReview: true, boards: false }))(BOARD)).toEqual({ status: 409, code: "shape_off" });
  });
});
