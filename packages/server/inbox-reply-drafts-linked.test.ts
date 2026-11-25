/**
 * A reply draft on a thread that lives on another linked machine (the owner, 2026-11-24: "Whatever I can do on one
 * computer, I should be able to do across computers"). Two real Inboxes linked both ways through the CLI pairing, every
 * proof both ways: each list says the mark `reply-drafts`; a save from the window here lands in the draft there, its own
 * window reads it, this list's row says Draft and the Drafts page lists it; a save there reads here; Discard deletes it
 * there; a Send that carries it clears it there; Take back puts the words back in the draft there and here; with that
 * machine asleep, the save is held (nothing "waiting", no notice), read back here through a restart of this Inbox, and
 * lands there when it is back. Starts Inboxes: CI only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, startInbox, stopInbox, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

interface Machine {
  w: InboxWorld;
  name: string;
  id: string;
  /** The agent's message on this machine: the thread the other machine drafts a reply in. */
  message: { id: string; thread: string };
}

const base = (m: Machine) => `http://127.0.0.1:${registry(m.w).port}`;

function cli(m: Machine, ...args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync([join(m.w.bin, "plannotator"), "inbox", ...args], { env: { ...(process.env as Record<string, string>), ...worldEnv(m.w), PLANNOTATOR_UPDATE_CHECK: "0", PLANNOTATOR_INBOX_NOTES: "0" }, cwd: m.w.root });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}
const getJson = async (m: Machine, path: string): Promise<Json> => (await (await fetch(`${base(m)}${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } })).json()) as Json;
/** The window's own write: its Origin, `Sec-Fetch-Site: same-origin`, and this run's page session. */
async function windowPost(m: Machine, path: string, body: Json, thread?: string): Promise<Response> {
  const { serverSession } = await getJson(m, "/api/inbox/health");
  return fetch(`${base(m)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base(m), "Sec-Fetch-Site": "same-origin", ...(thread ? { "X-Plannotator-Thread": thread } : {}) },
    body: JSON.stringify({ serverSession, ...body }),
  });
}

async function agentAsks(m: Machine): Promise<{ id: string; thread: string }> {
  const client = new Client({ name: "inbox-reply-drafts-linked", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(m)}/mcp`)));
  try {
    const sent = (await client.callTool({ name: "send_message", arguments: { body: `Retry the refund webhook on ${m.name}?`, project_path: m.w.project, agent_session: `ses-${m.name}`, agent_host: "claude-code" } })) as { structuredContent: { thread_id: string; message_id: string } };
    return { id: sent.structuredContent.message_id, thread: sent.structuredContent.thread_id };
  } finally {
    await client.close().catch(() => {});
  }
}

/** The draft as the thread's own machine holds it, read by its own window. */
const draftThere = async (there: Machine) => (await getJson(there, `/api/inbox/threads/${there.message.thread}/draft`)).draft as Json | null;
/** The draft as the window here reads it, through the forward. */
const draftHere = async (here: Machine, there: Machine) => (await getJson(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}/draft`)).draft as Json | null;
const saveHere = (here: Machine, there: Machine, body: string, base: string | null, baseBody: string | null = null) =>
  windowPost(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}/draft`, { body, base, base_body: baseBody, files_add: [], files_remove: [], files_place: [] }, there.message.thread);
const stateOf = async (viewer: Machine, other: Machine) => ((await getJson(viewer, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === other.id)?.state;

describe("a reply draft on a linked machine's thread, two real Inboxes linked both ways", () => {
  let stubs: string[] = [];
  let A: Machine;
  let B: Machine;

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    const machines: Machine[] = [];
    for (const name of ["Studio", "MacBook"]) {
      const w = createInboxWorld(`plannotator-linked-drafts-${name.toLowerCase()}-`, `linked-drafts-${name}`, "linked-drafts");
      const m: Machine = { w, name, id: "", message: { id: "", thread: "" } };
      const started = cli(m, "--background");
      if (started.code !== 0) throw new Error(`inbox --background failed: ${started.err}`);
      m.id = (await getJson(m, "/api/inbox/health")).inbox_id as string;
      m.message = await agentAsks(m);
      machines.push(m);
    }
    [A, B] = machines as [Machine, Machine];
    const offered = cli(B, "link", "--offer");
    expect(offered.code).toBe(0);
    const linked = cli(A, "link", offered.out.trim(), "--address", base(B), "--back", base(A));
    if (linked.code !== 0) throw new Error(`link failed: ${linked.err}`);
    expect(linked.out).toContain("both ways");
  }, 90_000);

  afterAll(async () => {
    for (const m of [A, B]) if (m) await destroyInboxWorld(m.w);
    removeStubbedHtml(stubs);
  });

  const both = () =>
    [
      [A, B],
      [B, A],
    ] as const;

  test("each machine keeps the other's drafts of its threads: its list names the mark", async () => {
    for (const [here, there] of both()) {
      const listed = await waitFor(`${here.name} has read ${there.name}'s list`, async () => ((await getJson(here, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === there.id && (m.marks as string[]).length > 0) ?? null);
      expect(listed.marks).toContain("reply-drafts");
    }
  }, 30_000);

  test("a save here is the draft there; there's own window, this list's row and the Drafts page show it; a save there reads here", async () => {
    for (const [here, there] of both()) {
      const saved = await saveHere(here, there, `Typed on the ${here.name}`, null);
      expect(saved.status).toBe(200);
      const draft = ((await saved.json()) as Json).draft;
      expect(draft).toMatchObject({ body: `Typed on the ${here.name}` });
      expect((await draftThere(there))?.body).toBe(`Typed on the ${here.name}`);
      // Nothing was held: it went straight there.
      expect((await getJson(here, "/api/inbox/outbox")).waiting).toEqual([]);
      const row = await waitFor("the row's Draft mark", async () =>
        (((await getJson(here, "/api/inbox/threads?machines=1")).sections as Json[]).flatMap((s) => s.threads as Json[]).find((r) => r.thread_id === there.message.thread && r.unsent?.reply_at) ?? null),
      );
      expect(row.machine).toBe(there.id);
      const listed = ((await getJson(here, "/api/inbox/drafts")).replies as Json[]).find((r) => r.thread_id === there.message.thread);
      expect(listed).toMatchObject({ machine: there.id, reply_preview: `Typed on the ${here.name}` });
      // Its own window writes on: the window here reads that.
      const own = await windowPost(there, `/api/inbox/threads/${there.message.thread}/draft`, { body: `Typed on the ${here.name}, then on the ${there.name}`, base: draft.updated_at, files_add: [], files_remove: [], files_place: [] });
      expect(own.status).toBe(200);
      expect((await draftHere(here, there))?.body).toBe(`Typed on the ${here.name}, then on the ${there.name}`);
    }
  }, 60_000);

  test("Discard here deletes the draft there", async () => {
    for (const [here, there] of both()) {
      const gone = await windowPost(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}/draft/delete`, {}, there.message.thread);
      expect(gone.status).toBe(200);
      expect(await draftThere(there)).toBeNull();
      expect(await draftHere(here, there)).toBeNull();
    }
  }, 30_000);

  test("a Send that carries the draft clears it there; Take back puts the words back in the draft, read here too", async () => {
    for (const [here, there] of both()) {
      const saved = ((await (await saveHere(here, there, `Ship it from the ${here.name}`, null)).json()) as Json).draft;
      const read = await getJson(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}`);
      const sent = await windowPost(
        here,
        `/api/inbox/m/${there.id}/messages/${there.message.id}/reply`,
        { idempotency_key: `send-${here.name}`, words: `Ship it from the ${here.name}`, questions: [], clear_draft: saved.updated_at, seen_through_seq: read.cursor },
        there.message.thread,
      );
      expect(sent.status).toBe(200);
      const reply = ((await sent.json()) as Json).reply;
      expect(await draftThere(there)).toBeNull();
      const taken = await windowPost(here, `/api/inbox/m/${there.id}/messages/${reply.id}/take-back`, {}, there.message.thread);
      expect(taken.status).toBe(200);
      expect((await draftThere(there))?.body).toBe(`Ship it from the ${here.name}`);
      expect((await draftHere(here, there))?.body).toBe(`Ship it from the ${here.name}`);
      await windowPost(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}/draft/delete`, {}, there.message.thread);
    }
  }, 60_000);

  test("that machine asleep: the saves are held (nothing waiting, no notice), read back through a restart here, and the newest lands when it is back, both ways", async () => {
    const heldFor = async (m: Machine, other: Machine) => ((await getJson(m, "/api/inbox/machines")).machines as Json[]).find((x) => x.id === other.id)?.drafts_held;
    for (const [here, there] of [
      [A, B],
      [B, A],
    ] as const) {
      await stopInbox(there.w);
      await waitFor(`${here.name} sees ${there.name} away`, async () => ((await stateOf(here, there)) === "offline" ? true : null), 30_000);
      // Autosaves while it sleeps: held here as one draft, never a write waiting in the outbox.
      let seen: string | null = null;
      let words = "";
      for (const more of ["Typed", " while", ` the ${there.name}`, " sleeps"]) {
        words += more;
        const held = await saveHere(here, there, words, seen);
        expect(held.status).toBe(200);
        seen = (((await held.json()) as Json).draft as Json).updated_at as string;
      }
      expect((await getJson(here, "/api/inbox/outbox")).waiting).toEqual([]);
      expect((await getJson(here, "/api/inbox/outbox")).notices).toEqual([]);
      expect(await heldFor(here, there)).toBe(1);
      expect((await draftHere(here, there))?.body).toBe(words);
      // This Inbox restarts while that machine still sleeps: the words are still the draft here.
      await stopInbox(here.w);
      startInbox(here.w);
      expect((await draftHere(here, there))?.body).toBe(words);
      startInbox(there.w);
      const landed = await waitFor(`the held draft landed on the ${there.name}`, async () => ((await draftThere(there))?.body === words ? true : null), 60_000);
      expect(landed).toBe(true);
      await waitFor("nothing held any more", async () => ((await heldFor(here, there)) === 0 ? true : null), 30_000);
      expect((await getJson(here, "/api/inbox/outbox")).notices).toEqual([]);
      await windowPost(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}/draft/delete`, {}, there.message.thread);
    }
  }, 300_000);
});
