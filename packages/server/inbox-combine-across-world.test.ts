/**
 * Combine across linked computers on two real Inboxes, linked both ways over loopback (approval
 * "inbox-combine-across-computers"; docs/agent-guides/inbox-messages.md, "Combine…"). A is the window's computer, B
 * the other; an agent on each (an MCP client) wrote one thread on its own computer.
 *
 * What regresses: B's agents missing from "Who writes it" when asked through A's forward, or a running agent of B that
 * wrote in no pick missing with picks on two computers (`all=1`), or refused as the writer; a Combine with a thread on
 * the other computer refused; the other computer's picked thread not archived there once the new thread arrives, or
 * not brought back by Undo; the writer on B (asked from A's window) unable to read or archive A's thread, or A's files
 * not copied to B's new thread; B combining a thread A's waiting Combine holds; B asleep when the thread arrives losing
 * B's archive instead of holding it until B is back, or that held archive listed as the person's waiting write; an Undo
 * while B sleeps said done before it lands there.
 *
 * Starts Inboxes: CI runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** No real tailscale ever runs: the loopback transport is the test sandbox's, and serve holds nothing. */
const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });

describe("Combine across two linked computers", () => {
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
  const start = (dataDir: string) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, readProjectRepo: async () => null });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  /** A press in that Inbox's window: its own Origin and page session. */
  const press = async (port: number, path: string, body: Json) => {
    const health = await get(port, "/api/inbox/health");
    const res = await fetch(`${at(port)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: at(port) }, body: JSON.stringify({ serverSession: health.serverSession, ...body }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const agentOn = async (port: number, name: string) => {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${at(port)}/mcp`)));
    return client;
  };
  const send = async (client: Client, args: Json) => ((await client.callTool({ name: "send_message", arguments: args })) as { structuredContent: { thread_id: string } }).structuredContent.thread_id;
  const ask = (q: string) => [q, "", ":::question", q, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

  test("both ways: the agents of both computers are offered, the chosen one's computer combines, archives the other's thread there, copies its files, holds it busy, and Undo brings both back; the other asleep, its archive and its Undo wait for it", async () => {
    const dataA = scratch("plannotator-combine-across-a-");
    const dataB = scratch("plannotator-combine-across-b-");
    const a = await start(dataA);
    let b = await start(dataB);
    const projectA = scratch("plannotator-combine-across-project-a-");
    const projectB = scratch("plannotator-combine-across-project-b-");
    let onA: Client | null = null;
    let onB: Client | null = null;
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const bOnA = async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId);
      const aOnB = async () => ((await get(b.port, "/api/inbox/machines")).machines as Json[]).find((m) => !m.self);
      await waitFor("B online on A, taking Combines across computers", async () => (await bOnA())?.state === "online" && ((await bOnA())?.marks ?? []).includes("combine-across"), 30_000);
      await waitFor("A online on B", async () => (await aOnB())?.state === "online", 30_000);

      onA = await agentOn(a.port, "combine-across-a");
      onB = await agentOn(b.port, "combine-across-b");
      const threadOn = (client: Client, project: string, session: string, subject: string) => send(client, { project_path: project, agent_session: session, subject, body: ask(`${subject}: ship it?`) });
      const a1 = await threadOn(onA, projectA, "ses_a", "Invoice retries");
      const b1 = await threadOn(onB, projectB, "ses_b", "Retry worker backoff");
      const archivedOn = (inbox: { store: { message: (id: string) => { resolved_at: string | null } | null } }, id: string) => inbox.store.message(id)?.resolved_at != null;

      // "Who writes it": each computer answers for its own picks, B's through A's forward.
      expect(((await get(a.port, `/api/inbox/combine?threads=${a1}`)).agents as Json[]).map((x) => x.session)).toEqual(["ses_a"]);
      expect(((await get(a.port, `/api/inbox/m/${bId}/combine?threads=${b1}`)).agents as Json[]).map((x) => x.session)).toEqual(["ses_b"]);

      // 1. The writer on A, with B's thread picked: the Combine and the new thread are A's.
      const here = await press(a.port, "/api/inbox/combine", { thread_ids: [a1, b1], session: "ses_a", idempotency_key: "world-1" });
      expect(here.status).toBe(200);
      const one = here.body.combine as Json;
      expect(one.threads.map((t: Json) => t.id)).toEqual([a1, b1]);
      expect([archivedOn(a, a1), archivedOn(b, b1)]).toEqual([false, false]);
      // ses_a reads B's thread itself, as the wake asks.
      const read = (await onA.callTool({ name: "read_thread", arguments: { thread_id: b1, agent_session: "ses_a" } })) as { isError?: boolean };
      expect(read.isError).toBeFalsy();
      const made1 = await send(onA, { project_path: projectA, agent_session: "ses_a", subject: "Retries, combined", body: "Where it all stands.", idempotency_key: one.id });
      await waitFor("both picked threads archived, each on its own computer", () => archivedOn(a, a1) && archivedOn(b, b1), 30_000);
      expect(archivedOn(a, made1)).toBe(false);
      expect((await press(a.port, `/api/inbox/combine/${one.id}/undo`, { idempotency_key: "world-1-undo" })).body.combine.state).toBe("undone");
      await waitFor("both back after Undo", () => !archivedOn(a, a1) && !archivedOn(b, b1), 30_000);

      // 2. The writer on B is a running agent there that wrote in no pick, pressed in A's window: offered with `all=1`,
      // it reads and archives A's thread, and A's file is copied to its new thread.
      await fetch(`${at(b.port)}${INBOX_BRIDGE_POLL_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ session: "ses_b_idle", host: "claude-code", project_path: projectB, waitMs: 0 }) });
      writeFileSync(join(projectA, "ledger-notes.md"), "# Ledger\n\nExport nightly.\n");
      const a2 = await send(onA, { project_path: projectA, agent_session: "ses_a", subject: "Ledger export", body: ask("Ledger export: ship it?"), attachments: [join(projectA, "ledger-notes.md")] });
      const b2 = await threadOn(onB, projectB, "ses_b", "Refund totals");
      expect(((await get(a.port, `/api/inbox/m/${bId}/combine?threads=${b2}`)).agents as Json[]).map((x) => x.session)).toEqual(["ses_b"]);
      expect(((await get(a.port, `/api/inbox/m/${bId}/combine?threads=${b2}&all=1`)).agents as Json[]).map((x) => [x.session, x.threads])).toEqual([
        ["ses_b", 1],
        ["ses_b_idle", 0],
      ]);
      const there = await press(a.port, `/api/inbox/m/${bId}/combine`, { thread_ids: [a2, b2], session: "ses_b_idle", idempotency_key: "world-2" });
      expect(there.status).toBe(200);
      const two = there.body.combine as Json;
      expect(two.threads.map((t: Json) => t.id)).toEqual([a2, b2]);
      // The wake went to B's chosen agent, in B's own picked thread.
      expect(b.store.pendingReplies("ses_b_idle").some((m) => m.tidy?.id === two.id && m.tidy?.wake === true && m.thread_id === b2)).toBe(true);
      // While it waits, A's thread is busy on A too: A's own Combine of it is refused in A's words.
      const a2b = await threadOn(onA, projectA, "ses_a", "Ledger import");
      const busy = await press(a.port, "/api/inbox/combine", { thread_ids: [a2, a2b], session: "ses_a", idempotency_key: "world-busy" });
      expect([busy.body.code, busy.body.error]).toEqual(["already_combining", "Ledger export is already being combined."]);
      const made2 = await send(onB, { project_path: projectB, agent_session: "ses_b_idle", subject: "Exports and refunds", body: "One thread.", idempotency_key: two.id });
      await waitFor("A's thread archived by B, and B's own", () => archivedOn(a, a2) && archivedOn(b, b2), 30_000);
      await waitFor("A's file copied to B's new thread", () => (b.store.message(made2)?.attachments ?? []).some((f) => f.name === "ledger-notes.md"), 30_000);
      const undoThere = await press(a.port, `/api/inbox/m/${bId}/combine/${two.id}/undo`, { idempotency_key: "world-2-undo" });
      expect(undoThere.status).toBe(200);
      await waitFor("both back after Undo from A's window", () => !archivedOn(a, a2) && !archivedOn(b, b2), 30_000);

      // 3. B asleep when the new thread arrives on A: A's thread goes now, B's is held and lands when B is back.
      const a3 = await threadOn(onA, projectA, "ses_a", "Webhook docs");
      const b3 = await threadOn(onB, projectB, "ses_b", "Webhook retries");
      const three = (await press(a.port, "/api/inbox/combine", { thread_ids: [a3, b3], session: "ses_a", idempotency_key: "world-3" })).body.combine as Json;
      await onB.close();
      onB = null;
      b.stop();
      await waitFor("B offline on A", async () => (await bOnA())?.state === "offline", 30_000);
      await send(onA, { project_path: projectA, agent_session: "ses_a", subject: "Webhooks, combined", body: "x", idempotency_key: three.id });
      await waitFor("A's thread archived", () => archivedOn(a, a3), 15_000);
      const threeOnA = async () => ((await get(a.port, "/api/inbox/combine")).combines as Json[]).find((c) => c.id === three.id)!;
      await waitFor("B's archive held on A", async () => ((await threeOnA()).waiting_on ?? []).includes(bId), 15_000);
      // This Inbox's own write: never listed as the person's waiting write.
      expect(((await get(a.port, "/api/inbox/outbox")).waiting as Json[]).filter((e) => e.machine === bId)).toEqual([]);
      b = await start(dataB);
      await waitFor("B's thread archived once B is back", () => archivedOn(b, b3), 60_000);
      await waitFor("nothing waits on B any more", async () => (await threeOnA()).waiting_on === undefined, 30_000);

      // 4. Undo while B sleeps: done on A at once, said to wait for B until it lands there.
      b.stop();
      await waitFor("B offline on A again", async () => (await bOnA())?.state === "offline", 30_000);
      const undone = (await press(a.port, `/api/inbox/combine/${three.id}/undo`, { idempotency_key: "world-3-undo" })).body.combine as Json;
      expect([undone.state, undone.waiting_on]).toEqual(["undone", [bId]]);
      expect(archivedOn(a, a3)).toBe(false);
      b = await start(dataB);
      await waitFor("B's thread back once B is back", () => !archivedOn(b, b3), 60_000);
      await waitFor("the Undo no longer waits", async () => (await threeOnA()).waiting_on === undefined, 30_000);
    } finally {
      await onA?.close().catch(() => {});
      await onB?.close().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 360_000);
});
