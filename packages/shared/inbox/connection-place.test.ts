/**
 * Where a session lives (INBOX_PLACE_POLL_FIELD): the hint a connection reads
 * from the environment its host started with, and what a poll may carry. The
 * failures these guard: a session in tmux inside Rex claiming tmux's Rex pane;
 * a stray REX_* outside Rex taken as a place; a name, a server or any other
 * field riding along on a place; a newer connection's other kind breaking an
 * Inbox that knows only Rex; the shared connection sending a place outside Rex.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_BRIDGE_POLL_PATH, INBOX_PLACE_POLL_FIELD, inboxPlaceFromEnv, parseInboxPlace } from "./connection";
import { InboxAgentConnection, InboxWake } from "./agent-link";

const SESSION = "session:01a1eb88-f030-7da4-aa20-0dc3df15fce2";
const BLOCK = "block:01a1eb88-f030-7eb1-9448-bf75ec96f726";
const REX = { TERM_PROGRAM: "rex", REX_SESSION: SESSION, REX_BLOCK: BLOCK };

describe("the place hint", () => {
  test("Rex's own terminal: its session and block ids", () => {
    expect(inboxPlaceFromEnv(REX)).toEqual({ kind: "rex", session: SESSION, block: BLOCK });
  });

  test("tmux (or another terminal) inside Rex sets its own TERM_PROGRAM: nothing", () => {
    expect(inboxPlaceFromEnv({ ...REX, TERM_PROGRAM: "tmux" })).toBeNull();
    expect(inboxPlaceFromEnv({ ...REX, TERM_PROGRAM: undefined })).toBeNull();
    expect(inboxPlaceFromEnv({ ...REX, TERM_PROGRAM: "Apple_Terminal" })).toBeNull();
  });

  test("an id missing or not Rex's shape: nothing", () => {
    expect(inboxPlaceFromEnv({ TERM_PROGRAM: "rex", REX_SESSION: SESSION })).toBeNull();
    expect(inboxPlaceFromEnv({ ...REX, REX_BLOCK: "pane 1" })).toBeNull();
    expect(inboxPlaceFromEnv({ ...REX, REX_SESSION: BLOCK })).toBeNull();
    expect(inboxPlaceFromEnv({ ...REX, REX_SESSION: `${SESSION}\n` })).toBeNull();
  });

  test("under test (bun test, or a sandboxed Plannotator) never: a test run from a Rex pane does not send the person's pane", () => {
    expect(inboxPlaceFromEnv({ ...REX, NODE_ENV: "test" })).toBeNull();
    expect(inboxPlaceFromEnv({ ...REX, PLANNOTATOR_TEST_SANDBOX: "1" })).toBeNull();
    expect(inboxPlaceFromEnv({ ...REX, NODE_ENV: "production" })).toEqual({ kind: "rex", session: SESSION, block: BLOCK });
  });

  test("REX_SERVER is never part of it", () => {
    expect(inboxPlaceFromEnv({ ...REX, REX_SERVER: "/elsewhere.sock" } as typeof REX)).toEqual({ kind: "rex", session: SESSION, block: BLOCK });
  });
});

describe("a place on a poll", () => {
  test("only the two ids are kept: a name or anything else on it is dropped", () => {
    expect(parseInboxPlace({ kind: "rex", session: SESSION, block: BLOCK, label: "my session", tab: "x", server: "/s" })).toEqual({ kind: "rex", session: SESSION, block: BLOCK });
  });

  test("absent (an older connection), another kind (a newer one) or malformed: none", () => {
    expect(parseInboxPlace(undefined)).toBeNull();
    expect(parseInboxPlace({ kind: "herdr", session: SESSION, block: BLOCK })).toBeNull();
    expect(parseInboxPlace([SESSION, BLOCK])).toBeNull();
    expect(parseInboxPlace("rex")).toBeNull();
    expect(parseInboxPlace({ kind: "rex", session: 1, block: BLOCK })).toBeNull();
  });
});

describe("the shared connection's poll (Pi, OpenCode and the other hosts on agent-link)", () => {
  async function pollBody(env: Record<string, string | undefined>) {
    const bodies: Record<string, unknown>[] = [];
    class Capturing extends InboxAgentConnection {
      override async bridge(path: string, _session: string, body: Record<string, unknown>) {
        if (path === INBOX_BRIDGE_POLL_PATH) bodies.push(body);
        return { status: 200, text: JSON.stringify({ commands: [] }) };
      }
    }
    const connection = new Capturing({ dataDir: "/nonexistent-plannotator-test", host: "pi", agentName: "Pi", tools: [], env });
    const wake = new InboxWake(connection, "ses-1", { isBusy: () => false, deliver: async () => undefined, notify: () => undefined });
    await (wake as unknown as { pendingNow(waitMs: number): Promise<unknown> }).pendingNow(0);
    wake.dispose();
    expect(bodies).toHaveLength(1);
    return bodies[0]!;
  }

  test("in Rex's terminal: the place rides on the poll", async () => {
    expect((await pollBody(REX))[INBOX_PLACE_POLL_FIELD]).toEqual({ kind: "rex", session: SESSION, block: BLOCK });
  });

  test("anywhere else, tmux inside Rex included: no such field", async () => {
    expect(INBOX_PLACE_POLL_FIELD in (await pollBody({ ...REX, TERM_PROGRAM: "tmux" }))).toBe(false);
    expect(INBOX_PLACE_POLL_FIELD in (await pollBody({}))).toBe(false);
  });

  test("a connection under test sends none, even from Rex's terminal", async () => {
    expect(INBOX_PLACE_POLL_FIELD in (await pollBody({ ...REX, PLANNOTATOR_TEST_SANDBOX: "1" }))).toBe(false);
  });
});
