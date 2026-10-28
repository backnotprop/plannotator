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
import { clearInboxDuplicates, dropInboxDuplicates, findInboxConnection, inboxRepeatLine, inboxRepeatPointer, recordInboxDuplicate, registerInboxOpenCode2, type InboxToolDomainLike } from "./inbox";
import {
  createInboxWorld,
  destroyInboxWorld,
  personSends,
  pressSendNow,
  QUESTION,
  registry,
  removeStubbedHtml,
  sendNowOffered,
  startInbox,
  stubBuiltHtml,
  waitFor,
  type InboxWorld,
} from "../../tests/helpers/inbox-world";

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const saved = { ...process.env };
/** Each test's wakes, stopped after it so no lease timer or event loop outlives it. */
const stops: AbortController[] = [];

beforeAll(() => {
  stubs = stubBuiltHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
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
  let closed = false;
  return {
    /** The host's stream ends by itself (a dropped connection). */
    close() {
      closed = true;
      wake?.();
    },
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
          if (closed) return;
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
    const stop = new AbortController();
    stops.push(stop);
    await registerInboxOpenCode2(toolDomain, v2 as never, connection!, async (sessionID) => ({ root: sessionID }), { signal: stop.signal });
    expect(events.subscribers).toBe(1);
    expect(events.aborted).toBe(0);

    // The first request builds the tool list: the tool is there, and the agent sends.
    let tool: { execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> } | null = null;
    pending!({ add: (definition) => (tool = definition as never) });
    expect(tool).not.toBeNull();
    const sessionID = "ses_events";
    events.emit({ type: "session.execution.started", data: { sessionID } });
    const sent = await tool!.execute({ action: "send_message", body: QUESTION }, { sessionID });
    const structured = JSON.parse(sent.content.slice(sent.content.indexOf("{"))) as { message_id: string; thread_id: string };
    events.emit({ type: "session.execution.succeeded", data: { sessionID } });
    w.proof(`sent ${structured.message_id}; the session ran and ended (events only)`);

    await personSends(w, structured.message_id, "Retry with the same key.");
    const delivered = await waitFor("the reply to reach the session", () => prompts.find((prompt) => prompt.text.startsWith("Plannotator Inbox: ")), 20_000);
    expect(delivered.sessionID).toBe(sessionID);
    expect(delivered.text).toContain("Retry with the same key.");
    // It closes with the thread and the tool OpenCode registered (plannotator_inbox).
    expect(delivered.text.endsWith(`\n\n[thread ${structured.thread_id} · more: plannotator_inbox read_thread · how it works: plannotator inbox --help]`)).toBe(true);
    expect(events.aborted).toBe(0);
    w.proof(`delivered through the events alone:\n${delivered.text}`);

    // Stopping the wakes ends the event subscription.
    stop.abort();
    await waitFor("the event subscription to end", () => (events.aborted === 1 ? true : undefined), 5_000);
  }, 60_000);

  test("the wake's poll carries the session's folder and turn state: a session that never wrote is listed under its project, idle or working (compose)", async () => {
    const w = createInboxWorld("plannotator-inbox-oc2-poll-", "07-opencode2-poll-fields", "opencode2");
    worlds.push(w);
    startInbox(w);
    mkdirSync(w.dataDir, { recursive: true });
    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
    process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
    process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");
    const connection = await findInboxConnection();
    const events = eventStream();
    const v2 = {
      location: { directory: "/somewhere/else" },
      event: { subscribe: events.subscribe },
      session: {
        // The session's own folder wins over the plugin's.
        get: async () => ({ location: { directory: w.project } }),
        wait: async () => undefined,
        prompt: async () => undefined,
      },
    };
    const stop = new AbortController();
    stops.push(stop);
    await registerInboxOpenCode2({ transform: () => {} }, v2 as never, connection!, async (sessionID) => ({ root: sessionID }), { signal: stop.signal });
    // A run starts in a session that has never written in the Inbox: its wake starts and polls.
    const sessionID = "ses_quiet";
    events.emit({ type: "session.execution.started", data: { sessionID } });
    const listed = async () => {
      const model = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/sessions`)).json()) as {
        projects: { project: { root: string }; sessions: { session: string; host: string; busy: boolean | null }[] }[];
      };
      return model.projects.find((group) => group.project.root === w.project)?.sessions.find((s) => s.session === sessionID) ?? null;
    };
    const working = await waitFor("the session listed as working", async () => {
      const entry = await listed();
      return entry?.busy === true ? entry : null;
    });
    expect(working.host).toBe("opencode");
    events.emit({ type: "session.execution.succeeded", data: { sessionID } });
    await waitFor("the session listed as idle", async () => ((await listed())?.busy === false ? true : null), 20_000);
    w.proof(`listed under ${w.project}, working then idle, before it wrote anything`);
  }, 60_000);

  test("a draft without `add` (an older host): no tool, and the wakes stop at once (the event subscription ends)", async () => {
    const w = createInboxWorld("plannotator-inbox-oc2-noadd-", "06-opencode2-draft-without-add", "opencode2");
    worlds.push(w);
    startInbox(w);
    mkdirSync(w.dataDir, { recursive: true });
    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
    process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
    process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");

    const connection = await findInboxConnection();
    expect(connection).not.toBeNull();
    const events = eventStream();
    const v2 = {
      location: { directory: w.project },
      event: { subscribe: events.subscribe },
      session: { prompt: async () => {} },
    };
    const stop = new AbortController();
    stops.push(stop);
    // An eager host whose draft has no `add`.
    const toolDomain: InboxToolDomainLike = { transform: (apply) => void apply({}) };
    const added = await registerInboxOpenCode2(toolDomain, v2 as never, connection!, async (sessionID) => ({ root: sessionID }), { signal: stop.signal });
    expect(added).toBe(false);
    expect(events.subscribers).toBe(1);
    await waitFor("the event subscription to end", () => (events.aborted === 1 ? true : undefined), 5_000);
    w.proof("a draft without add: registered nothing, and the wakes' event subscription ended");
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("OpenCode 2's Send now (a steer, confirmed by its delivery)", () => {
  async function world(name: string) {
    const w = createInboxWorld("plannotator-inbox-oc2-steer-", name, "opencode2");
    worlds.push(w);
    startInbox(w);
    mkdirSync(w.dataDir, { recursive: true });
    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
    process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
    process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");
    const connection = await findInboxConnection();
    const events = eventStream();
    const prompts: { id: string; text: string; delivery: string }[] = [];
    const v2 = {
      location: { directory: w.project },
      event: { subscribe: events.subscribe },
      session: {
        get: async () => ({ location: { directory: w.project } }),
        wait: async () => undefined,
        prompt: async (input: { id: string; text: string; delivery: string }) => {
          prompts.push({ id: input.id, text: input.text, delivery: input.delivery });
        },
      },
    };
    let pending: Parameters<NonNullable<InboxToolDomainLike["transform"]>>[0] | null = null;
    const stop = new AbortController();
    stops.push(stop);
    await registerInboxOpenCode2({ transform: (apply) => void (pending = apply) }, v2 as never, connection!, async (sessionID) => ({ root: sessionID }), { signal: stop.signal });
    let tool: { execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> } | null = null;
    pending!({ add: (definition) => (tool = definition as never) });
    const sessionID = "ses_steer";
    events.emit({ type: "session.execution.started", data: { sessionID } });
    const sent = await tool!.execute({ action: "send_message", body: QUESTION }, { sessionID });
    const asked = JSON.parse(sent.content.slice(sent.content.indexOf("{"))) as { message_id: string; thread_id: string };
    return { w, events, prompts, sessionID, asked };
  }

  test("busy: Send now steers the reply into the run, and it counts as delivered only once OpenCode delivers that row", async () => {
    const { w, events, prompts, sessionID, asked } = await world("08-opencode2-send-now-steer");
    const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await Bun.sleep(1_500);
    expect(prompts).toEqual([]);
    await pressSendNow(w, replyId);
    const steer = await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    expect(steer.text).toContain(`(${replyId})`);
    await Bun.sleep(1_000);
    const deliveryOf = async () => ((await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${asked.thread_id}`)).json()) as { thread: { messages: { id: string; delivery?: unknown }[] } }).thread.messages.find((m) => m.id === replyId)?.delivery;
    // Not delivered until OpenCode says the row entered the model context.
    expect(await deliveryOf()).toBeUndefined();
    events.emit({ type: "session.inbox.delivered", data: { sessionID, inboxID: steer.id } });
    expect(await waitFor("the delivery record", deliveryOf)).toMatchObject({ host: "opencode", session: sessionID });
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
  }, 60_000);

  test("the run ends before OpenCode delivers the steer row: after the grace it goes in as a queued turn", async () => {
    const { w, events, prompts, sessionID, asked } = await world("09-opencode2-send-now-steer-fallback");
    const replyId = await personSends(w, asked.message_id, "Fail the job and alert.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await pressSendNow(w, replyId);
    await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    events.emit({ type: "session.execution.succeeded", data: { sessionID } });
    const queued = await waitFor("the queued turn", () => prompts.find((prompt) => prompt.delivery === "queue"), 15_000);
    const steer = prompts.find((prompt) => prompt.delivery === "steer")!;
    // The fallback is the steer's text plus the repeat line.
    expect(queued.text).toBe(`${steer.text}\n\n${inboxRepeatLine(replyId)}`);
    // OpenCode then promotes the steer row with the queued turn (#1734): the model reads one copy, the
    // earlier; the later, the last message's whole content, stays as a pointer, so the request still ends
    // on a user message.
    const request: unknown[] = [
      { role: "assistant", content: "Working on it." },
      { role: "user", content: [{ type: "text", text: steer.text }] },
      { role: "user", content: queued.text },
    ];
    expect(dropInboxDuplicates(request)).toBe(1);
    expect(request).toHaveLength(3);
    expect((request[1] as { content: { text: string }[] }).content[0]!.text).toBe(steer.text);
    expect(request[2]).toEqual({ role: "user", content: inboxRepeatPointer(replyId) });
    const delivery = await waitFor("the delivery record", async () =>
      ((await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${asked.thread_id}`)).json()) as { thread: { messages: { id: string; delivery?: unknown }[] } }).thread.messages.find((m) => m.id === replyId)?.delivery,
    );
    expect(delivery).toMatchObject({ host: "opencode" });
  }, 60_000);
});

describe("Send now duplicates in OpenCode 2's model requests (dropInboxDuplicates)", () => {
  afterEach(() => clearInboxDuplicates());

  test("of the steer row and its fallback, the later copy is dropped, in either order; one copy alone is kept", () => {
    recordInboxDuplicate("msg_r", "WAKE", "WAKE\n\nrepeat");
    const fallbackFirst: unknown[] = [{ role: "user", content: "WAKE\n\nrepeat" }, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "text", text: "WAKE" }, { type: "text", text: "and more" }] }];
    expect(dropInboxDuplicates(fallbackFirst)).toBe(1);
    expect(fallbackFirst).toHaveLength(3);
    expect((fallbackFirst[2] as { content: { text: string }[] }).content.map((part) => part.text)).toEqual(["and more"]);
    const alone: unknown[] = [{ role: "user", content: "WAKE" }];
    expect(dropInboxDuplicates(alone)).toBe(0);
    expect(alone).toHaveLength(1);
    // Never the assistant's words, nor another reply.
    const other: unknown[] = [{ role: "assistant", content: "WAKE" }, { role: "user", content: "WAKE" }, { role: "user", content: "OTHER" }];
    expect(dropInboxDuplicates(other)).toBe(0);
  });

  test("a later copy that is its message's whole content becomes a pointer, never removed: the request never ends on the assistant", () => {
    recordInboxDuplicate("msg_r", "WAKE", "WAKE\n\nrepeat");
    // The steer row went into the run (answered there), then the fallback came as a turn of its own.
    const request: unknown[] = [
      { role: "user", content: [{ type: "text", text: "WAKE" }] },
      { role: "assistant", content: "Done, retried." },
      { role: "user", content: [{ type: "text", text: "WAKE\n\nrepeat" }] },
    ];
    expect(dropInboxDuplicates(request)).toBe(1);
    expect(request).toHaveLength(3);
    expect((request.at(-1) as { role: string }).role).toBe("user");
    expect((request[2] as { content: { text: string }[] }).content).toEqual([{ type: "text", text: inboxRepeatPointer("msg_r") }]);
    // The same in every later request (a stable prompt prefix): the pointer is not a copy, so it stays.
    const later = structuredClone(request);
    later.push({ role: "assistant", content: "Already answered." }, { role: "user", content: "next" });
    expect(dropInboxDuplicates(later)).toBe(0);
    expect(later.slice(0, 3)).toEqual(request);
    // A string message too.
    const asString: unknown[] = [{ role: "user", content: "WAKE" }, { role: "assistant", content: "ok" }, { role: "user", content: "WAKE\n\nrepeat" }];
    dropInboxDuplicates(asString);
    expect(asString[2]).toEqual({ role: "user", content: inboxRepeatPointer("msg_r") });
  });
});

describe.skipIf(process.platform === "win32")("OpenCode 2's Send now: the steer becomes queued, or the event stream ends", () => {
  /** `session.wait`: pending while the run goes on, answered once the test ends it. */
  function runGate() {
    let running = true;
    const waiters: (() => void)[] = [];
    return {
      wait: () => (running ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()),
      end() {
        running = false;
        for (const resolve of waiters.splice(0)) resolve();
      },
    };
  }

  async function world(name: string, options: { wait?: () => Promise<unknown>; context?: () => Promise<unknown> } = {}) {
    const w = createInboxWorld("plannotator-inbox-oc2-steer2-", name, "opencode2");
    worlds.push(w);
    startInbox(w);
    mkdirSync(w.dataDir, { recursive: true });
    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
    process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
    process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");
    const connection = await findInboxConnection();
    const events = eventStream();
    const prompts: { id: string; text: string; delivery: string }[] = [];
    const v2 = {
      location: { directory: w.project },
      event: { subscribe: events.subscribe },
      session: {
        get: async () => ({ location: { directory: w.project } }),
        wait: options.wait ?? (async () => undefined),
        ...(options.context ? { context: options.context } : {}),
        prompt: async (input: { id: string; text: string; delivery: string }) => {
          prompts.push({ id: input.id, text: input.text, delivery: input.delivery });
        },
      },
    };
    let pending: Parameters<NonNullable<InboxToolDomainLike["transform"]>>[0] | null = null;
    const stop = new AbortController();
    stops.push(stop);
    await registerInboxOpenCode2({ transform: (apply) => void (pending = apply) }, v2 as never, connection!, async (sessionID) => ({ root: sessionID }), { signal: stop.signal });
    let tool: { execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> } | null = null;
    pending!({ add: (definition) => (tool = definition as never) });
    const sessionID = "ses_steer2";
    events.emit({ type: "session.execution.started", data: { sessionID } });
    const sent = await tool!.execute({ action: "send_message", body: QUESTION }, { sessionID });
    const asked = JSON.parse(sent.content.slice(sent.content.indexOf("{"))) as { message_id: string; thread_id: string };
    return { w, events, prompts, sessionID, asked, stop };
  }

  test("OpenCode turns the steer row into a queued row: it will be delivered, so no fallback is sent", async () => {
    const { w, events, prompts, sessionID, asked } = await world("10-opencode2-steer-becomes-queued");
    const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await pressSendNow(w, replyId);
    const steer = await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    events.emit({ type: "session.inbox.delivery.changed", data: { sessionID, inboxID: steer.id, delivery: "queue" } });
    events.emit({ type: "session.execution.succeeded", data: { sessionID } });
    await waitFor("the delivery record", async () =>
      ((await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${asked.thread_id}`)).json()) as { thread: { messages: { id: string; delivery?: unknown }[] } }).thread.messages.find((m) => m.id === replyId)?.delivery,
    );
    await Bun.sleep(4_000);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
  }, 60_000);

  const deliveryOf = async (w: ReturnType<typeof createInboxWorld>, threadId: string, replyId: string) =>
    ((await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${threadId}`)).json()) as { thread: { messages: { id: string; delivery?: unknown }[] } }).thread.messages.find((m) => m.id === replyId)?.delivery;

  test("a long tool call: the run goes on with no event for longer than the old 60 s cap would allow; no fallback, and the steer counts once delivered", async () => {
    const gate = runGate();
    const { w, events, prompts, sessionID, asked } = await world("12-opencode2-steer-long-tool-call", { wait: gate.wait });
    const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await pressSendNow(w, replyId);
    const steer = await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    // No event for longer than the 60 s cap this used to have, and past RUNNING_CROSS_CHECK_MS (20 s): the
    // cross-check asks OpenCode, which says the run goes on.
    await Bun.sleep(65_000);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
    expect(await deliveryOf(w, asked.thread_id, replyId)).toBeUndefined();
    // The tool call returns; the run's next step promotes the row.
    events.emit({ type: "session.inbox.delivered", data: { sessionID, inboxID: steer.id } });
    expect(await waitFor("the delivery record", () => deliveryOf(w, asked.thread_id, replyId))).toMatchObject({ host: "opencode", session: sessionID });
    gate.end();
    events.emit({ type: "session.execution.succeeded", data: { sessionID } });
    await Bun.sleep(4_000);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
  }, 120_000);

  test("the event stream ends mid-run: no fallback while the run goes on; once idle, a row the context holds counts as delivered", async () => {
    const gate = runGate();
    let context: unknown[] = [];
    const { w, events, prompts, sessionID, asked } = await world("11-opencode2-steer-stream-ends", { wait: gate.wait, context: async () => context });
    const replyId = await personSends(w, asked.message_id, "Fail the job and alert.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await pressSendNow(w, replyId);
    const steer = await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    events.close();
    await Bun.sleep(8_000);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
    // The run promoted the row at its next step (the plugin could not see it), then ended.
    context = [
      { id: "msg_a", type: "user", content: [{ type: "text", text: "Start the job." }] },
      { id: steer.id, type: "user", content: [{ type: "text", text: steer.text }] },
      { id: "msg_b", type: "assistant", content: [{ type: "text", text: "Failing it and alerting." }] },
    ];
    gate.end();
    expect(await waitFor("the delivery record", () => deliveryOf(w, asked.thread_id, replyId), 15_000)).toMatchObject({ host: "opencode" });
    await Bun.sleep(3_000);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
  }, 60_000);

  test("the event stream ends mid-run and the row never entered: once idle, the fallback goes queued (its copy deduplicated)", async () => {
    const gate = runGate();
    const { w, events, prompts, sessionID, asked } = await world("13-opencode2-steer-stream-ends-undelivered", { wait: gate.wait, context: async () => [] });
    const replyId = await personSends(w, asked.message_id, "Fail the job and alert.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await pressSendNow(w, replyId);
    await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    events.close();
    await Bun.sleep(6_000);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
    gate.end();
    const queued = await waitFor("the queued turn", () => prompts.find((prompt) => prompt.delivery === "queue"), 15_000);
    expect(queued.text.endsWith(inboxRepeatLine(replyId))).toBe(true);
    expect(await waitFor("the delivery record", () => deliveryOf(w, asked.thread_id, replyId))).toMatchObject({ host: "opencode" });
  }, 60_000);

  test("the session is deleted while its steer row waits: the row is given up, its watch stops, and no fallback goes into the deleted session", async () => {
    let contextCalls = 0;
    const { w, events, prompts, sessionID, asked } = await world("14-opencode2-steer-session-deleted", {
      context: async () => {
        contextCalls++;
        return [];
      },
    });
    const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await pressSendNow(w, replyId);
    await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    events.emit({ type: "session.deleted", data: { sessionID } });
    await Bun.sleep(200);
    // Were the steer still watched, the stream ending would have it read the context once idle, then send the fallback.
    events.close();
    await Bun.sleep(6_000);
    expect(contextCalls).toBe(0);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
    expect(await deliveryOf(w, asked.thread_id, replyId)).toBeUndefined();
  }, 60_000);

  test("OpenCode shuts down while a steer row waits: no fallback is sent during shutdown, and the reply stays undelivered for the next start", async () => {
    const { w, prompts, sessionID, asked, stop } = await world("15-opencode2-steer-dispose");
    const replyId = await personSends(w, asked.message_id, "Fail the job and alert.");
    await sendNowOffered(w, asked.thread_id, sessionID);
    await pressSendNow(w, replyId);
    await waitFor("the steer row", () => prompts.find((prompt) => prompt.delivery === "steer"));
    stop.abort();
    await Bun.sleep(4_000);
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["steer"]);
    expect(await deliveryOf(w, asked.thread_id, replyId)).toBeUndefined();
  }, 60_000);
});
