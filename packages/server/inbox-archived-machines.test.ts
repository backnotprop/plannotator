/**
 * The list's Archived group across linked machines, on two real Inboxes (approval "inbox-archived-group"; the
 * person's rule: a linked machine's archived threads show in the group, and Unarchive works on them).
 *
 * What this catches: a linked machine's archived threads missing from the group's read or carrying no machine (so
 * Unarchive would go to the wrong store); the plain read (Settings → Archived) taking far rows; Unarchive from here
 * not landing on the machine that holds the thread; an asleep machine's rows dropped from the group, or its
 * Unarchive lost instead of held and sent when it is back; an archived row without its tags (so no tag colour), or a
 * far one with that machine's tag ids instead of the merged ones; and the "Show archived" switch not reaching the
 * other machine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** A `tailscale` stand-in that keeps a serve config (as inbox-machines.test.ts does). */
function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
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
}

describe("the Archived group across linked machines", () => {
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
  const start = (dataDir: string, storeNow?: () => Date) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale(), ...(storeNow ? { storeNow } : {}) });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  const post = async (port: number, path: string, body: Json) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: health.serverSession, ...body }) });
  };
  let keys = 0;
  const forward = (port: number, machine: string, route: string, body: Json) => post(port, `/api/inbox/m/${machine}/${route}`, { idempotency_key: `window-unarchive-${++keys}`, ...body });
  /** The group's read: the ids and the machine each lives on. */
  const group = async (port: number) => {
    const page = await get(port, "/api/inbox/threads/archived?machines=1&limit=21");
    return { rows: (page.threads as Json[]).map((row) => [row.thread_id, row.machine ?? null]), machines: page.machines as Record<string, { away: boolean }> };
  };

  test("B's archived threads show on A with their machine; Unarchive from A lands on B; B asleep, its rows stay and the Unarchive waits; the switch reaches B", async () => {
    const dataA = scratch("plannotator-archived-linked-a-");
    const dataB = scratch("plannotator-archived-linked-b-");
    const a = await start(dataA);
    // B's store clock: the wall clock, moved a second on between the two archives so they never tie (a fast runner
    // archives both in one millisecond, and a tie reads by thread id; inbox-archived-order.test.ts).
    let skew = 0;
    let b = await start(dataB, () => new Date(Date.now() + skew));
    let client: Client | null = null;
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      client = new Client({ name: "inbox-archived-linked", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${at(b.port)}/mcp`)));
      const project = scratch("plannotator-archived-linked-project-");
      const send = async (body: string) => ((await client!.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_b", body } })) as { structuredContent: { thread_id: string } }).structuredContent.thread_id;
      const older = await send("Older news");
      const newer = await send("Newer news");
      expect((await post(b.port, `/api/inbox/messages/${older}/resolve`, { resolved: true })).status).toBe(200);
      skew += 1_000;
      expect((await post(b.port, `/api/inbox/messages/${newer}/resolve`, { resolved: true })).status).toBe(200);

      // Newest archived first, each with B as its machine; the plain read (Settings → Archived) stays this Inbox's own.
      await waitFor("B's archived on A", async () => (await group(a.port)).rows.length === 2);
      expect(await group(a.port)).toEqual({ rows: [[newer, bId], [older, bId]], machines: { [bId]: { away: false } } });
      expect((await get(a.port, "/api/inbox/threads/archived?limit=21")).threads).toEqual([]);

      // A tagged archived thread carries its tag, on B's own read and as A's merged tag on A's: its row takes the tag's colour.
      const tagged = (await (await post(b.port, `/api/inbox/threads/${older}/tags`, { name: "payments", on: true })).json()) as Json;
      expect(((await get(b.port, "/api/inbox/threads/archived?limit=21")).threads as Json[]).find((row) => row.thread_id === older)?.tags).toEqual(tagged.tags);
      const mergedTag = async () => ((await get(a.port, "/api/inbox/threads?machines=1")).tags as Json[]).find((tag) => tag.name === "payments")?.id as string | undefined;
      const olderTags = async () => ((await get(a.port, "/api/inbox/threads/archived?machines=1&limit=21")).threads as Json[]).find((row) => row.thread_id === older)?.tags;
      await waitFor("the tag on A's archived row", async () => {
        const id = await mergedTag();
        return id !== undefined && JSON.stringify(await olderTags()) === JSON.stringify([id]);
      }, 15_000);

      // Unarchive from A goes to B, through the forward.
      expect((await forward(a.port, bId, `messages/${newer}/resolve`, { resolved: false })).status).toBe(200);
      expect(b.store.message(newer)!.resolved_at).toBeNull();
      expect((await group(a.port)).rows).toEqual([[older, bId]]);

      // The switch, turned on in A's window, is B's too.
      expect((await post(a.port, "/api/inbox/settings", { show_archived: { on: true } })).status).toBe(200);
      await waitFor("the switch on B", async () => (await get(b.port, "/api/inbox/settings")).show_archived?.on === true, 15_000);

      // B asleep: its archived row stays, marked away; Unarchive is held (202) and lands when B is back.
      await client.close();
      client = null;
      b.stop();
      await waitFor("B offline on A", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "offline", 30_000);
      expect(await group(a.port)).toEqual({ rows: [[older, bId]], machines: { [bId]: { away: true } } });
      expect((await forward(a.port, bId, `messages/${older}/resolve`, { resolved: false })).status).toBe(202);
      b = await start(dataB);
      await waitFor("the held Unarchive on B", () => b.store.message(older)?.resolved_at === null, 45_000);
      await waitFor("the group on A empty", async () => (await group(a.port)).rows.length === 0, 15_000);
    } finally {
      await client?.close().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 120_000);
});
