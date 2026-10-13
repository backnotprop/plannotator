/**
 * OpenCode 2's reply wake driven by the session's own execution events, with
 * the `session.wait` fallback taken away. A real Inbox under a temp data dir;
 * the OpenCode 2 host is a fake that behaves like the real one where it
 * matters here: it applies a tool transform LAZILY (the callback runs when a
 * request builds its tool list, not when the plugin registers it), streams
 * events from `event.subscribe`, and its `session.wait` fails.
 *
 * The failure this guards: registerInboxOpenCode2 read "the draft took the
 * tool" right after `transform(...)`, which a lazy host has not applied yet,
 * and disposed the wakes, aborting the event subscription. The wake then
 * fell back to `session.wait` for every busy check, and with that failing
 * a reply never reached an idle session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findInboxConnection, registerInboxOpenCode2, type InboxToolDomainLike } from "./inbox";
import {
  createInboxWorld,
  destroyInboxWorld,
  personSends,
  QUESTION,
  removeStubbedHtml,
  startInbox,
  stubBuiltHtml,
  waitFor,
  type InboxWorld,
} from "../../tests/helpers/inbox-world";

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const saved = { ...process.env };

beforeAll(() => {
  stubs = stubBuiltHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_BIN"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const w of worlds.splice(0)) await destroyInboxWorld(w);
});

/** An OpenCode 2 event stream the test feeds, ending when the subscriber's signal aborts. */
function eventStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let subscribers = 0;
  let aborted = 0;
  return {
    emit(event: unknown) {
      queue.push(event);
      wake?.();
    },
    get subscribers() {
      return subscribers;
    },
    get aborted() {
      return aborted;
    },
    subscribe({ signal }: { signal?: AbortSignal } = {}) {
      subscribers++;
      return (async function* () {
        while (!signal?.aborted) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        aborted++;
      })();
    },
  };
}

describe.skipIf(process.platform === "win32")("OpenCode 2's Inbox wake on a host that applies tool transforms lazily", () => {
  test("the reply reaches the idle session through the execution events alone (session.wait fails)", async () => {
    const w = createInboxWorld("plannotator-inbox-oc2-wake-", "05-opencode2-event-driven-wake", "opencode2");
    worlds.push(w);
    startInbox(w);
    mkdirSync(w.dataDir, { recursive: true });
    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
    process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
    process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");

    const connection = await findInboxConnection();
    expect(connection).not.toBeNull();
    const events = eventStream();
    const prompts: { sessionID: string; text: string }[] = [];
    const v2 = {
      location: { directory: w.project },
      event: { subscribe: events.subscribe },
      session: {
        get: async () => ({ location: { directory: w.project } }),
        // The fallback is gone: only the events can say the session is idle.
        wait: async () => {
          throw new Error("session.wait is not available on this host");
        },
        prompt: async (input: { sessionID: string; text: string }) => {
          prompts.push({ sessionID: input.sessionID, text: input.text });
        },
      },
    };
    // A lazy host: it keeps the callback and applies it when a request builds its tools.
    let pending: Parameters<NonNullable<InboxToolDomainLike["transform"]>>[0] | null = null;
    const toolDomain: InboxToolDomainLike = {
      transform: (apply) => {
        pending = apply;
      },
    };
    await registerInboxOpenCode2(toolDomain, v2 as never, connection!, async (sessionID) => ({ root: sessionID }));
    expect(events.subscribers).toBe(1);
    expect(events.aborted).toBe(0);

    // The first request builds the tool list: the tool is there, and the agent sends.
    let tool: { execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> } | null = null;
    pending!({ add: (definition) => (tool = definition as never) });
    expect(tool).not.toBeNull();
    const sessionID = "ses_events";
    events.emit({ type: "session.execution.started", data: { sessionID } });
    const sent = await tool!.execute({ action: "send_message", body: QUESTION }, { sessionID });
    const structured = JSON.parse(sent.content.slice(sent.content.indexOf("{"))) as { message_id: string };
    events.emit({ type: "session.execution.succeeded", data: { sessionID } });
    w.proof(`sent ${structured.message_id}; the session ran and ended (events only)`);

    await personSends(w, structured.message_id, "Retry with the same key.");
    const delivered = await waitFor("the reply to reach the session", () => prompts.find((prompt) => prompt.text.startsWith("Plannotator Inbox: ")), 20_000);
    expect(delivered.sessionID).toBe(sessionID);
    expect(delivered.text).toContain("Retry with the same key.");
    expect(events.aborted).toBe(0);
    w.proof(`delivered through the events alone:\n${delivered.text}`);
  }, 60_000);
});
