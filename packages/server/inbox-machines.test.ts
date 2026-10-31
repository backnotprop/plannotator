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
 *  2. An agent on B asks and long-polls B (wait_for_reply over MCP); A's
 *     merged list and event stream show it; the person answers from A
 *     through the forward; B's waiting agent wakes with the answer.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer } from "./inbox";
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

/** An agent session on a machine: send_message and wait_for_reply over the real MCP client. */
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
    wait: (threadId: string, seconds: number) =>
      client.callTool({ name: "wait_for_reply", arguments: { thread_id: threadId, agent_session: SESSION, timeout_seconds: seconds } }, undefined, {
        timeout: (seconds + 30) * 1000,
      }) as Promise<{ structuredContent: { status: string; reply?: { body: string; message_id: string } } }>,
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
  });

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

  test("2. an agent on B asks and waits; the person answers from A; B's agent wakes", async () => {
    const agent = await agentOn(B);
    try {
      // A's merged stream (opened first, as a window holds it) raises B's question as a live record of B's.
      let sent!: { thread_id: string; message_id: string };
      let listening!: () => void;
      const subscribed = new Promise<void>((resolve) => (listening = resolve));
      const watching = streamUntil(
        A,
        (event, data) => event === "machine" && data.machine === B.id && data.live === true && data.record?.message?.id === sent?.message_id,
        15_000,
        listening,
      );
      await subscribed;
      sent = await agent.send(QUESTION(1), { thread: "case-1" });
      const waiting = agent.wait(sent.thread_id, 30);
      const frames = await watching;
      expect(frames.find((f) => f.event === "machines")).toBeDefined();
      expect(frames.some((f) => f.event === "machine" && f.data.record?.message?.id === sent.message_id)).toBe(true);
      const row = await waitFor("B's thread in A's merged list", async () => (await mergedRows(A)).find((r) => r.thread_id === sent.thread_id));
      expect(row.machine).toBe(B.id);
      // A holds a cursor of B's list (the window's cue to read the merged list again); A's own has none.
      const views = await machinesOf(A);
      expect(typeof views.find((x) => x.id === B.id)!.list_cursor).toBe("number");
      expect(views.find((x) => x.self)!.list_cursor).toBeNull();
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
      const woke = await waiting;
      expect(woke.structuredContent.status).toBe("replied");
      expect(woke.structuredContent.reply!.body).toContain("Retry with the same key.");
      expect(woke.structuredContent.reply!.message_id).toBe(reply.reply.id);
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
        fetch(`${base(A)}/api/inbox/m/${B.id}/uploads?name=notes.txt&idempotency_key=window-upload-${session.slice(0, 4)}&serverSession=${session}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Origin: base(A) },
          body: "notes for B",
        });
      expect((await upload("0".repeat(32))).status).toBe(409);
      const uploaded = await upload(serverSession);
      expect(uploaded.status).toBe(200);
      expect(uploaded.headers.get("x-plannotator-outbox")).toBeNull();
      expect(((await uploaded.json()) as Json).upload).toBeDefined();
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
    // The agent on B, back after the restart, gets the answer that waited: the wake.
    const back = await agentOn(B);
    try {
      const woke = await back.wait(sent.thread_id, 10);
      expect(woke.structuredContent.status).toBe("replied");
      expect(woke.structuredContent.reply!.body).toContain("Alert, do not retry.");
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
