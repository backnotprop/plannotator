/**
 * A reply draft on a thread that lives on another linked machine (the owner, 2026-11-24: "Whatever I can do on one
 * computer, I should be able to do across computers"). Two real Inboxes linked both ways through the CLI pairing, every
 * proof both ways: each list says the mark `reply-drafts`; a save from the window here lands in the draft there, its own
 * window reads it, this list's row says Draft and the Drafts page lists it; a save there reads here; Discard deletes it
 * there; a Send that carries it clears it there; Take back puts the words back in the draft there and here; with that
 * machine asleep, the save is held (nothing "waiting", no notice), read back here through a restart of this Inbox, and
 * lands there when it is back. The person's words and files are never lost, doubled, brought back or written over:
 * the paste removed while away lands as left; a held Discard spares newer words typed there; a held save that meets
 * newer words there is offered, never joined (and becomes the draft when the draft there was discarded); a file swept
 * there is named; a reply held with the draft settles it only once delivered, and a refused one gives the words back;
 * Unlink from the other computer hands every held word, file name and quote to "Not sent". "Meanwhile there" is made
 * by stopping this Inbox while that machine's own window writes. Starts Inboxes: CI only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { removeInboxUploads } from "@plannotator/shared/inbox/uploads";
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
const heldFor = async (m: Machine, other: Machine) => ((await getJson(m, "/api/inbox/machines")).machines as Json[]).find((x) => x.id === other.id)?.drafts_held;

const draftPath = (there: Machine) => `/api/inbox/m/${there.id}/threads/${there.message.thread}/draft`;
/** The whole read here: the draft and any words of the person's it does not hold (`not_landed`). */
const readHere = (here: Machine, there: Machine) => getJson(here, draftPath(there));
const writeHere = (here: Machine, there: Machine, body: Json) => windowPost(here, draftPath(there), { files_add: [], files_remove: [], files_place: [], ...body }, there.message.thread);
const draftOf = async (answer: Response): Promise<Json> => {
  expect(answer.status).toBe(200);
  return ((await answer.json()) as Json).draft as Json;
};
const discardHere = (here: Machine, there: Machine, body: Json = {}) => windowPost(here, `${draftPath(there)}/delete`, body, there.message.thread);
/** That machine's own window writes its draft. */
const typedThere = (there: Machine, body: string, base: string | null) => windowPost(there, `/api/inbox/threads/${there.message.thread}/draft`, { body, base, files_add: [], files_remove: [], files_place: [] });

async function away(here: Machine, there: Machine) {
  await stopInbox(there.w);
  await waitFor(`${here.name} sees ${there.name} away`, async () => ((await stateOf(here, there)) === "offline" ? true : null), 30_000);
}
const seesOnline = (here: Machine, there: Machine) => waitFor(`${here.name} sees ${there.name} online`, async () => ((await stateOf(here, there)) === "online" ? true : null), 60_000);
async function back(here: Machine, there: Machine) {
  startInbox(there.w);
  await seesOnline(here, there);
}
/** That machine wakes while this Inbox is down: its own window writes before this Inbox can land what it holds. */
async function wakesWhileHereIsDown(here: Machine, there: Machine) {
  await stopInbox(here.w);
  startInbox(there.w);
}
/** A file the window here sends to that machine (a pasted text, a picture): it streams there, never held. */
async function uploadHere(here: Machine, there: Machine, name: string, text: string): Promise<Json> {
  const { serverSession } = await getJson(here, "/api/inbox/health");
  const answer = await fetch(`${base(here)}/api/inbox/m/${there.id}/uploads?name=${encodeURIComponent(name)}&idempotency_key=up-${crypto.randomUUID()}&serverSession=${serverSession}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: base(here) },
    body: text,
  });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as Json).upload as Json;
}

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
      const taken = await windowPost(here, `/api/inbox/m/${there.id}/messages/${reply.id}/take-back`, { idempotency_key: `take-back-${here.name}` }, there.message.thread);
      expect(taken.status).toBe(200);
      expect((await draftThere(there))?.body).toBe(`Ship it from the ${here.name}`);
      expect((await draftHere(here, there))?.body).toBe(`Ship it from the ${here.name}`);
      await windowPost(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}/draft/delete`, {}, there.message.thread);
    }
  }, 60_000);

  test("that machine asleep: the saves are held (nothing waiting, no notice), read back through a restart here, and the newest lands when it is back, both ways", async () => {
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

  test("away, a long paste becomes a chip, autosaves, then the chip is removed and some words deleted: back, the draft lands as left and both sides agree, both ways", async () => {
    for (const [here, there] of both()) {
      await seesOnline(here, there);
      // The paste's upload went there just before it slept (an upload is never held).
      const paste = await uploadHere(here, there, "pasted-text.txt", "a long pasted line\n".repeat(300));
      await away(here, there);
      const typed = `Notes for the ${there.name}. `.repeat(20);
      const chip = { upload_id: paste.upload_id, pasted: { at: typed.length, preview: "a long pasted line" } };
      let draft = await draftOf(await writeHere(here, there, { body: typed, base: null, files_add: [chip], files_place: [chip] }));
      expect(draft.files.map((f: Json) => f.upload_id)).toEqual([paste.upload_id]);
      draft = await draftOf(await writeHere(here, there, { body: `${typed}And a last line.`, base: draft.updated_at, base_body: draft.body }));
      const left = typed.slice(0, 120);
      draft = await draftOf(await writeHere(here, there, { body: left, base: draft.updated_at, base_body: draft.body, files_remove: [paste.upload_id] }));
      expect(draft.body).toBe(left);
      expect(draft.files ?? []).toEqual([]);
      expect((await readHere(here, there)).draft.body).toBe(left);
      await back(here, there);
      await waitFor(`the draft landed on the ${there.name}`, async () => ((await draftThere(there))?.body === left ? true : null), 60_000);
      await waitFor("nothing held any more", async () => ((await heldFor(here, there)) === 0 ? true : null), 30_000);
      const far = (await draftThere(there))!;
      const seen = await readHere(here, there);
      expect(far.files ?? []).toEqual([]);
      expect(seen.draft).toMatchObject({ body: left, updated_at: far.updated_at });
      expect(seen.draft.files ?? []).toEqual([]);
      expect(seen.not_landed).toBeUndefined();
      expect((await discardHere(here, there)).status).toBe(200);
    }
  }, 300_000);

  test("a held Discard goes only for the draft thrown away: newer words typed there meanwhile stay, both ways", async () => {
    for (const [here, there] of both()) {
      await seesOnline(here, there);
      const thrown = await draftOf(await writeHere(here, there, { body: `Thrown away on the ${here.name}`, base: null }));
      await away(here, there);
      expect((await discardHere(here, there, { base: thrown.updated_at })).status).toBe(200);
      expect((await readHere(here, there)).draft).toBeNull();
      await wakesWhileHereIsDown(here, there);
      expect((await typedThere(there, `Newer words typed on the ${there.name}`, thrown.updated_at)).status).toBe(200);
      startInbox(here.w);
      await waitFor("the held Discard answered there", async () => ((await stateOf(here, there)) === "online" && (await heldFor(here, there)) === 0 ? true : null), 60_000);
      expect((await draftThere(there))?.body).toBe(`Newer words typed on the ${there.name}`);
      expect((await readHere(here, there)).draft?.body).toBe(`Newer words typed on the ${there.name}`);
      expect((await discardHere(here, there)).status).toBe(200);
    }
  }, 300_000);

  test("a held save that meets newer words there: the draft there stays and these words are offered, never joined (Discard mine lets them go); discarded there meanwhile, these words become the draft; both ways", async () => {
    for (const [here, there] of both()) {
      await seesOnline(here, there);
      const start = await draftOf(await writeHere(here, there, { body: "Shared start", base: null }));
      await away(here, there);
      const mine = await draftOf(await writeHere(here, there, { body: `Shared start, typed on the ${here.name}`, base: start.updated_at, base_body: start.body }));
      await wakesWhileHereIsDown(here, there);
      expect((await typedThere(there, `Shared start, typed on the ${there.name}`, start.updated_at)).status).toBe(200);
      startInbox(here.w);
      const offered = await waitFor("the conflict offered here", async () => {
        const read = await readHere(here, there);
        return read.not_landed?.conflict ? read : null;
      }, 60_000);
      expect(offered.draft.body).toBe(`Shared start, typed on the ${there.name}`);
      expect(offered.not_landed).toMatchObject({ words: mine.body, version: mine.updated_at, conflict: true });
      expect((await draftThere(there))?.body).toBe(`Shared start, typed on the ${there.name}`);
      // Discard mine: only these words go; the draft there stays.
      expect((await discardHere(here, there, { not_landed: mine.updated_at })).status).toBe(200);
      expect((await readHere(here, there)).not_landed).toBeUndefined();
      expect((await draftThere(there))?.body).toBe(`Shared start, typed on the ${there.name}`);
      expect(await heldFor(here, there)).toBe(0);

      // Again, and this time the draft there is discarded meanwhile: these words are the draft.
      const theirs = (await draftThere(there))!;
      await away(here, there);
      await draftOf(await writeHere(here, there, { body: `Only the ${here.name}'s words`, base: theirs.updated_at, base_body: theirs.body }));
      await wakesWhileHereIsDown(here, there);
      expect((await windowPost(there, `/api/inbox/threads/${there.message.thread}/draft/delete`, {})).status).toBe(200);
      startInbox(here.w);
      await waitFor(`the words landed on the ${there.name}`, async () => ((await draftThere(there))?.body === `Only the ${here.name}'s words` ? true : null), 60_000);
      await waitFor("nothing held any more", async () => ((await heldFor(here, there)) === 0 ? true : null), 30_000);
      expect((await readHere(here, there)).not_landed).toBeUndefined();
      expect((await discardHere(here, there)).status).toBe(200);
    }
  }, 300_000);

  test("two held saves meet newer words there in a row: the first stays offered until it is let go, then the second; a Discard naming a version not shown leaves the newer words there; both ways", async () => {
    for (const [here, there] of both()) {
      await seesOnline(here, there);
      const start = await draftOf(await writeHere(here, there, { body: "Shared start", base: null }));
      await away(here, there);
      const first = await draftOf(await writeHere(here, there, { body: `First, from the ${here.name}`, base: start.updated_at, base_body: start.body }));
      await wakesWhileHereIsDown(here, there);
      const one = await draftOf(await typedThere(there, `One, typed on the ${there.name}`, start.updated_at));
      startInbox(here.w);
      await waitFor("the first words offered here", async () => ((await readHere(here, there)).not_landed?.conflict ? true : null), 60_000);
      // Another window here saves on the draft there while it sleeps again; that machine types again.
      await away(here, there);
      const second = await draftOf(await writeHere(here, there, { body: `Second, from the ${here.name}`, base: one.updated_at, base_body: one.body }));
      await wakesWhileHereIsDown(here, there);
      const two = await draftOf(await typedThere(there, `Two, typed on the ${there.name}`, one.updated_at));
      startInbox(here.w);
      const read = await waitFor("the second held save answered there", async () => {
        const seen = await readHere(here, there);
        return seen.draft?.body === two.body ? seen : null;
      }, 60_000);
      // The first words are still the ones offered; the second come once they are let go.
      expect(read.not_landed).toMatchObject({ words: first.body, version: first.updated_at, conflict: true });
      expect((await discardHere(here, there, { not_landed: first.updated_at })).status).toBe(200);
      expect((await readHere(here, there)).not_landed).toMatchObject({ words: second.body, version: second.updated_at, conflict: true });
      expect((await discardHere(here, there, { not_landed: second.updated_at })).status).toBe(200);
      expect((await readHere(here, there)).not_landed).toBeUndefined();
      expect(await heldFor(here, there)).toBe(0);
      // A Discard naming a version the window saw before the newer words there: refused, and they stay.
      expect((await discardHere(here, there, { base: one.updated_at })).status).toBe(409);
      expect((await draftThere(there))?.body).toBe(two.body);
      expect((await discardHere(here, there, { base: two.updated_at })).status).toBe(200);
      expect(await draftThere(there)).toBeNull();
    }
  }, 300_000);

  test("a held save naming a file swept there before it landed: the words land and the read names the file as not attached, both ways", async () => {
    for (const [here, there] of both()) {
      await seesOnline(here, there);
      const shot = await uploadHere(here, there, "screenshot.txt", "the pixels, as text");
      await away(here, there);
      const held = await draftOf(await writeHere(here, there, { body: "See the picture", base: null, files_add: [{ upload_id: shot.upload_id }] }));
      expect(held.files.map((f: Json) => f.name)).toEqual(["screenshot.txt"]);
      // While it sleeps that machine's day-old upload is swept.
      removeInboxUploads(inboxDir(there.w.dataDir), [shot.upload_id]);
      await back(here, there);
      await waitFor(`the words landed on the ${there.name}`, async () => ((await draftThere(there))?.body === "See the picture" ? true : null), 60_000);
      expect((await draftThere(there))?.files ?? []).toEqual([]);
      const read = await waitFor("the swept file named here", async () => {
        const seen = await readHere(here, there);
        return seen.not_landed?.files?.length ? seen : null;
      }, 30_000);
      expect(read.not_landed.files.map((f: Json) => f.name)).toEqual(["screenshot.txt"]);
      expect((await discardHere(here, there)).status).toBe(200);
    }
  }, 300_000);

  test("a reply sent while the draft is held settles it only once delivered there; a refused reply gives its words back as the draft, both ways", async () => {
    for (const [here, there] of both()) {
      await seesOnline(here, there);
      there.message = await agentAsks(there);
      const seen = (await getJson(here, `/api/inbox/m/${there.id}/threads/${there.message.thread}`)).cursor as number;
      const reply = (key: string, words: string, clear: string, seq: number) =>
        windowPost(here, `/api/inbox/m/${there.id}/messages/${there.message.id}/reply`, { idempotency_key: key, words, questions: [], clear_draft: clear, seen_through_seq: seq }, there.message.thread);

      await away(here, there);
      const shipped = await draftOf(await writeHere(here, there, { body: `Ship it from the ${here.name}`, base: null }));
      expect((await reply(`held-send-${here.name}`, shipped.body, shipped.updated_at, seen)).status).toBe(202);
      // Waiting to be delivered: the sent words do not show as the draft, and they are still held, through a restart here.
      expect((await readHere(here, there)).draft).toBeNull();
      await stopInbox(here.w);
      startInbox(here.w);
      expect((await readHere(here, there)).draft).toBeNull();
      expect(await heldFor(here, there)).toBe(1);
      await back(here, there);
      await waitFor("the reply delivered there", async () => ((await getJson(here, "/api/inbox/outbox")).waiting.length === 0 ? true : null), 60_000);
      await waitFor("the held draft settled", async () => ((await heldFor(here, there)) === 0 ? true : null), 60_000);
      expect(await draftThere(there)).toBeNull();
      expect((await readHere(here, there)).draft).toBeNull();

      // A reply that thread refuses (it moved on since the person read it): its words are the draft again, there too.
      await away(here, there);
      const late = await draftOf(await writeHere(here, there, { body: `Late words from the ${here.name}`, base: null }));
      expect((await reply(`late-send-${here.name}`, late.body, late.updated_at, 0)).status).toBe(202);
      expect((await readHere(here, there)).draft).toBeNull();
      await back(here, there);
      await waitFor("the refusal", async () => (((await getJson(here, "/api/inbox/outbox")).notices as Json[]).some((n) => n.key === `late-send-${here.name}` && n.notice?.kind === "refused") ? true : null), 60_000);
      await waitFor(`the words back as the draft on the ${there.name}`, async () => ((await draftThere(there))?.body === late.body ? true : null), 60_000);
      expect((await readHere(here, there)).draft?.body).toBe(late.body);
      expect((await discardHere(here, there)).status).toBe(200);
    }
  }, 600_000);

  // Last: it ends the link.
  test("Unlink from the other computer while a long draft with a file and a quote is held here: every word, the file's name and the quote are in Not sent", async () => {
    const [here, there] = [A, B];
    await seesOnline(here, there);
    const file = await uploadHere(here, there, "trace.txt", "the trace");
    const start = await draftOf(await writeHere(here, there, { body: "Start", base: null, files_add: [{ upload_id: file.upload_id }], quote: { of: there.message.id, words: "the refund webhook" } }));
    await away(here, there);
    const long = `Words for the ${there.name} before it goes. ${"Every one of these words must be kept. ".repeat(80)}The end.`;
    expect(long.length).toBeGreaterThan(2_000);
    const held = await draftOf(await writeHere(here, there, { body: long, base: start.updated_at, base_body: start.body }));
    expect(held).toMatchObject({ body: long, quote: { of: there.message.id, words: "the refund webhook" } });
    expect(held.files.map((f: Json) => f.name)).toEqual(["trace.txt"]);
    await wakesWhileHereIsDown(here, there);
    const unlinked = cli(there, "unlink", here.id);
    expect(unlinked.code).toBe(0);
    startInbox(here.w);
    await waitFor(`${here.name} forgot ${there.name}`, async () => (((await getJson(here, "/api/inbox/machines")).machines as Json[]).some((m) => m.id === there.id) ? null : true), 60_000);
    const lost = ((await getJson(here, "/api/inbox/outbox")).notices as Json[]).filter((n) => n.route === `threads/${there.message.thread}/draft`);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.every((n) => n.notice?.kind === "not_delivered")).toBe(true);
    expect(lost.map((n) => n.words).join("")).toBe(`${long}\n\nReplying to words in a message: “the refund webhook”\n\nAttached: trace.txt`);
  }, 300_000);
});
