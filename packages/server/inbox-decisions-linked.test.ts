/**
 * Decision mode on a linked computer's thread, on two real Inboxes linked both ways (the owner: whatever works on one
 * computer works on a linked computer's thread, with no guardrails or friction). A thread's decisions live on the
 * computer whose agent asked them; each Inbox's merged read (`GET /api/inbox/decisions?machines=1`) lists the other's,
 * and every answer goes there through the forward, the door's allowlist and the outbox. Starts two Inboxes: CI runs it.
 *
 * What this catches: a linked computer's decisions missing from the merged read (no "Decide these N" on its threads),
 * either way; a far decision not named by its computer (its answers would go to the wrong Inbox); a pick or an un-pick
 * from the window not landing there, or landing here; a Can't do it's reason sent there or held in the outbox (it is
 * the window's own Inbox's draft) or not read back; the other computer away: its decisions dropped instead of kept as
 * it last gave them, a pick or the Send refused instead of held, or a held one sent twice or not at all once it is
 * back; a phone reaching the decisions door route, or any door reaching a thread's comment drafts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { waitFor } from "../../tests/helpers/inbox-world";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

/** A `tailscale` stand-in that keeps a serve config (as inbox-scheduled-linked.test.ts does). */
function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`studio.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://studio.tail0000.ts.net:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
}

const QUESTIONS = [
  "Two calls before the harbor search index ships. Charlie Dunn signed off on the ranking.",
  "",
  ":::question",
  "Ship the new search index tonight?",
  "",
  "- [ ] Yes, tonight",
  "- [ ] No, wait for Monday",
  ":::",
  "",
  ":::question",
  "Keep the result count next to the search box?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

describe("decision mode on a linked computer's thread", () => {
  const dirs: string[] = [];
  const clients: Client[] = [];
  const envWas = { sandbox: process.env.PLANNOTATOR_TEST_SANDBOX, home: process.env.HOME };
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-decisions-linked-")));
    dirs.push(root);
    process.env.PLANNOTATOR_TEST_SANDBOX = root;
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.HOME, { recursive: true });
  });
  afterAll(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    for (const [name, was] of [["PLANNOTATOR_TEST_SANDBOX", envWas.sandbox], ["HOME", envWas.home]] as const) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const dataDir = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    return dir;
  };
  const start = (dir: string) => startInboxServer({ dataDir: dir, binaryPath: null, phones: false, tailscale: scriptedTailscale() });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  let keys = 0;
  /** A press in a window: its Origin and page session, and the window's key for a write to another machine. */
  const press = async (port: number, path: string, body: Json = {}) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { Origin: at(port), "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `window-decide-${++keys}`, ...body }) });
  };
  /** An agent on that Inbox asks its questions in a new thread of the harbor project. */
  const ask = async (server: InboxServer, session: string) => {
    const client = new Client({ name: "inbox-decisions-linked-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${at(server.port)}/mcp`)));
    clients.push(client);
    const project = join(root, `harbor-${session}`);
    mkdirSync(project, { recursive: true });
    const result = await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, agent_host: "claude-code", subject: "Ship the harbor search index?", body: QUESTIONS } });
    expect(result.isError).toBeFalsy();
    return result.structuredContent as { message_id: string; thread_id: string };
  };
  const merged = async (port: number) => ((await get(port, "/api/inbox/decisions?machines=1")).decisions as Json[]).map((d) => ({ id: d.id as string, machine: (d.machine ?? null) as string | null, key: d.question.key as string, revision: d.question.revision as number }));
  /** A question as its own Inbox serves its thread. */
  const question = async (server: InboxServer, threadId: string, messageId: string, key: string) =>
    ((await get(server.port, `/api/inbox/threads/${threadId}`)).thread.messages as Json[]).find((m) => m.id === messageId)!.questions.find((q: Json) => q.key === key) as Json;
  const answer = (key: string, prompt: string, selected: string) => ({ v: 1, key, kind: "single", prompt, selected: [selected] });

  test("each computer's merged read lists the other's decisions; picks, un-picks, reasons and Send land there, held while it is away and delivered once", async () => {
    const dataStudio = dataDir("studio");
    const dataLaptop = dataDir("laptop");
    const studio = await start(dataStudio);
    let laptop = await start(dataLaptop);
    try {
      const offered = (await (await fetch(`${at(laptop.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(studio.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(laptop.port), back: at(studio.port) }) });
      expect(linked.status).toBe(201);
      const laptopId = (JSON.parse(readFileSync(join(dataStudio, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const studioId = (JSON.parse(readFileSync(join(dataLaptop, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const takes = async (port: number, id: string) => ((await get(port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === id)?.marks?.includes("decisions") === true;
      await waitFor("Laptop's list on Studio", () => takes(studio.port, laptopId), 15_000);
      await waitFor("Studio's list on Laptop", () => takes(laptop.port, studioId), 15_000);

      // An agent on each computer asks; each computer's merged read has its own, then the other's, named by computer.
      const onLaptop = await ask(laptop, "ses_laptop");
      const onStudio = await ask(studio, "ses_studio");
      await waitFor("both ways", async () => {
        const [s, l] = [await merged(studio.port), await merged(laptop.port)];
        return s.filter((d) => d.machine === laptopId).length === 2 && l.filter((d) => d.machine === studioId).length === 2;
      }, 15_000);
      expect((await merged(studio.port)).map((d) => [d.id.split("/")[0], d.machine])).toEqual([
        [onStudio.message_id, null],
        [onStudio.message_id, null],
        [onLaptop.message_id, laptopId],
        [onLaptop.message_id, laptopId],
      ]);
      expect((await merged(laptop.port)).map((d) => d.machine)).toEqual([null, null, studioId, studioId]);
      // Without `machines=1` (a linked computer's door asks so), only this Inbox's own.
      expect(((await get(studio.port, "/api/inbox/decisions")).decisions as Json[]).every((d) => d.machine === undefined)).toBe(true);

      // From Studio's window, on Laptop's thread: a pick, and an un-pick of the other, land on Laptop, not on Studio.
      const far = `/api/inbox/m/${laptopId}`;
      const [q1, q2] = (await merged(studio.port)).filter((d) => d.machine === laptopId);
      const pick = (key: string, revision: number, value: Json | null) => press(studio.port, `${far}/messages/${onLaptop.message_id}/picks`, { unsent_only: true, questions: [{ key, revision, answer: value }] });
      expect((await pick(q1!.key, q1!.revision, answer(q1!.key, "Ship the new search index tonight?", "Yes, tonight"))).status).toBe(200);
      expect((await pick(q2!.key, q2!.revision, answer(q2!.key, "Keep the result count next to the search box?", "Yes"))).status).toBe(200);
      expect((await pick(q2!.key, q2!.revision + 1, null)).status).toBe(200);
      const onLaptopNow = (key: string) => question(laptop, onLaptop.thread_id, onLaptop.message_id, key);
      expect([(await onLaptopNow(q1!.key)).state, (await onLaptopNow(q2!.key)).state]).toEqual(["picked", "open"]);
      expect((await onLaptopNow(q1!.key)).answer?.selected).toEqual(["Yes, tonight"]);

      // A Can't do it's reason: Studio's own draft for Laptop's thread, named by Laptop, never sent there (only the mark
      // carries it). Laptop's comment drafts never see it.
      const reasonKey = `decision-reason:${onLaptop.message_id}/${q2!.key}`;
      const reason = (text: string) => press(studio.port, `/api/inbox/threads/${onLaptop.thread_id}/comment-draft`, { key: reasonKey, text, images: [], base: null, force: true, machine: laptopId });
      expect((await reason("Waiting on Bob Tully's review")).status).toBe(200);
      const readReason = async (port: number, machine: string | null) => ((await get(port, `/api/inbox/threads/${onLaptop.thread_id}/comment-draft?key=${encodeURIComponent(reasonKey)}${machine ? `&machine=${machine}` : ""}`)).draft as Json | null)?.text ?? null;
      expect(await readReason(studio.port, laptopId)).toBe("Waiting on Bob Tully's review");
      expect(await readReason(laptop.port, null)).toBeNull();

      // The thread as Studio's window last read it: a held Send carries what the person saw (rule 11).
      const seen = (await get(studio.port, `${far}/threads/${onLaptop.thread_id}`)).cursor as number;

      // Laptop goes to sleep. Studio keeps Laptop's decisions as Laptop last gave them, and every answer waits.
      laptop.stop();
      await waitFor("Laptop offline on Studio", async () => ((await get(studio.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === laptopId)?.state === "offline", 30_000);
      expect((await merged(studio.port)).filter((d) => d.machine === laptopId).map((d) => d.key)).toEqual([q1!.key, q2!.key]);
      const heldPick = await pick(q2!.key, q2!.revision + 2, answer(q2!.key, "Keep the result count next to the search box?", "No"));
      expect(heldPick.status).toBe(202);
      // Two reason saves while Laptop is away: each saved here at once, the last standing, and nothing held for Laptop.
      expect((await reason("Waiting on Bob Tully's review, then legal")).status).toBe(200);
      expect((await reason("Waiting on legal")).status).toBe(200);
      expect(await readReason(studio.port, laptopId)).toBe("Waiting on legal");
      const send = await press(studio.port, `${far}/messages/${onLaptop.message_id}/reply`, {
        words: "",
        seen_through_seq: seen,
        questions: [
          { key: q1!.key, revision: q1!.revision + 1 },
          { key: q2!.key, revision: q2!.revision + 3 },
        ],
      });
      expect(send.status).toBe(202);
      const sendKey = ((await send.json()) as Json).outbox.key as string;
      expect(((await get(studio.port, "/api/inbox/outbox")).waiting as Json[]).map((e) => e.route)).toEqual([
        `messages/${onLaptop.message_id}/picks`,
        `messages/${onLaptop.message_id}/reply`,
      ]);

      // Back: each lands there once, in order, and the Send sent both answers in one reply.
      laptop = await start(dataLaptop);
      await waitFor("the held Send on Laptop", async () => ((await get(studio.port, "/api/inbox/outbox")).waiting as Json[]).length === 0, 45_000);
      const notices = (await get(studio.port, "/api/inbox/outbox")).notices as Json[];
      expect(notices.filter((n) => n.key === sendKey)).toEqual([]);
      expect([(await onLaptopNow(q1!.key)).state, (await onLaptopNow(q2!.key)).state]).toEqual(["sent", "sent"]);
      expect((await onLaptopNow(q2!.key)).answer?.selected).toEqual(["No"]);
      const replies = laptop.store.threadMessageIds(onLaptop.thread_id).map((id) => laptop.store.message(id)!).filter((m) => m.author.kind === "person");
      expect(replies).toHaveLength(1);
      expect([await readReason(laptop.port, null), await readReason(studio.port, laptopId)]).toEqual([null, "Waiting on legal"]);
      // Studio's own thread never took any of it.
      expect(studio.store.threadMessageIds(onStudio.thread_id).map((id) => studio.store.message(id)!).filter((m) => m.author.kind === "person")).toEqual([]);
      // Once answered there, Laptop's decisions leave Studio's merged read.
      await waitFor("answered on Laptop", async () => (await merged(studio.port)).filter((d) => d.machine === laptopId).length === 0, 15_000);
    } finally {
      studio.stop();
      laptop.stop();
    }
  }, 180_000);

  test("a held Send whose held pick is refused there is refused with it: the agent never reads an answer made there instead", async () => {
    const dataStudio = dataDir("studio-collide");
    const dataLaptop = dataDir("laptop-collide");
    const studio = await start(dataStudio);
    let laptop = await start(dataLaptop);
    try {
      const offered = (await (await fetch(`${at(laptop.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(studio.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(laptop.port), back: at(studio.port) }) });
      expect(linked.status).toBe(201);
      const laptopId = (JSON.parse(readFileSync(join(dataStudio, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      await waitFor("Laptop's list on Studio", async () => ((await get(studio.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === laptopId)?.marks?.includes("decisions") === true, 15_000);
      const onLaptop = await ask(laptop, "ses_collide");
      await waitFor("Laptop's decisions on Studio", async () => (await merged(studio.port)).filter((d) => d.machine === laptopId).length === 2, 15_000);
      const [q] = (await merged(studio.port)).filter((d) => d.machine === laptopId);
      const prompt = "Ship the new search index tonight?";
      const far = `/api/inbox/m/${laptopId}`;
      const onLaptopNow = () => question(laptop, onLaptop.thread_id, onLaptop.message_id, q!.key);

      // Studio's window holds q at revision r. On Laptop's own window the person picks B (q at r + 1 there).
      expect((await press(laptop.port, `/api/inbox/messages/${onLaptop.message_id}/picks`, { unsent_only: true, questions: [{ key: q!.key, revision: q!.revision, answer: answer(q!.key, prompt, "No, wait for Monday") }] })).status).toBe(200);
      expect((await onLaptopNow()).revision).toBe(q!.revision + 1);
      const seen = (await get(studio.port, `${far}/threads/${onLaptop.thread_id}`)).cursor as number;

      // Laptop away. In Studio's window the person picks A (held, at r), then Send names q at the revision that pick
      // makes there (r + 1, farThread.ts), held behind it.
      laptop.stop();
      await waitFor("Laptop offline on Studio", async () => ((await get(studio.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === laptopId)?.state === "offline", 30_000);
      const heldPick = await press(studio.port, `${far}/messages/${onLaptop.message_id}/picks`, { unsent_only: true, questions: [{ key: q!.key, revision: q!.revision, answer: answer(q!.key, prompt, "Yes, tonight") }] });
      expect(heldPick.status).toBe(202);
      const pickKey = ((await heldPick.json()) as Json).outbox.key as string;
      const send = await press(studio.port, `${far}/messages/${onLaptop.message_id}/reply`, { words: "", seen_through_seq: seen, questions: [{ key: q!.key, revision: q!.revision + 1 }] });
      expect(send.status).toBe(202);
      const sendKey = ((await send.json()) as Json).outbox.key as string;

      // Laptop back: the pick is refused (q moved on there), and the Send with it, never sent: no reply on Laptop,
      // q still B there and not sent, and Studio's window is told both did not land (its Send's Try again).
      laptop = await start(dataLaptop);
      await waitFor("Studio's outbox settled", async () => ((await get(studio.port, "/api/inbox/outbox")).waiting as Json[]).length === 0, 45_000);
      const notices = (await get(studio.port, "/api/inbox/outbox")).notices as Json[];
      const told = (key: string) => notices.filter((n) => n.key === key).map((n) => [n.state, n.notice?.kind]);
      expect([told(pickKey), told(sendKey)]).toEqual([[["refused", "refused"]], [["refused", "refused"]]]);
      expect([(await onLaptopNow()).state, (await onLaptopNow()).answer?.selected]).toEqual(["picked", ["No, wait for Monday"]]);
      const replies = () => laptop.store.threadMessageIds(onLaptop.thread_id).map((id) => laptop.store.message(id)!).filter((m) => m.author.kind === "person");
      expect(replies()).toHaveLength(0);

      // Try again: a new key, from the thread as it is now there. It goes.
      const now = await get(studio.port, `${far}/threads/${onLaptop.thread_id}`);
      const again = await press(studio.port, `${far}/messages/${onLaptop.message_id}/reply`, { words: "", seen_through_seq: now.cursor, questions: [{ key: q!.key, revision: q!.revision + 1 }] });
      expect(again.status).toBe(200);
      expect(replies()).toHaveLength(1);
      expect((await onLaptopNow()).state).toBe("sent");
    } finally {
      studio.stop();
      laptop.stop();
    }
  }, 180_000);

  test("a phone never reaches the routes a linked computer's window uses for decision mode", async () => {
    const { doorRouteOf } = await import("./inbox-devices");
    expect(doorRouteOf("GET", "decisions", false)).toBeNull();
    expect(doorRouteOf("GET", "decisions", true)?.windowPath).toBe("/api/inbox/decisions");
    // A thread's comment drafts are on no door: a reason stays on the Inbox it was typed on.
    for (const method of ["GET", "POST"] as const) for (const machine of [false, true]) expect(doorRouteOf(method, "threads/msg_01JZ0000000000000000000000/comment-draft", machine)).toBeNull();
  });
});
