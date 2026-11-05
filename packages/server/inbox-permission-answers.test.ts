/**
 * Launch PR 2: who can answer a launched session's permission prompt, through
 * the real Inbox server. Guards: a bare local call (an agent's curl: no page
 * Origin) is refused and writes nothing; a Re-ask never sends a permission
 * question's picks; the window answers; and the person's paired phone answers
 * through the device door (its token checked there), which sends no Origin.
 * Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
let relayBefore: string | undefined;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (relayBefore === undefined) delete process.env.PLANNOTATOR_RELAY_URL;
  else process.env.PLANNOTATOR_RELAY_URL = relayBefore;
});

const SESSION = "0d6c2f1e-5b7a-4c8e-9f00-bbbbbbbbbbbb";
const CARD = ["```", "bun run build", "```", "", "in `~/billing`", "", ":::question", "Claude Code wants to run a command", "", "- [ ] Allow once", "- [ ] Deny", ":::"].join("\n");

/** Two open permission questions, written as the permission route writes them, then the server on the same data dir. */
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-perm-answers-")));
  roots.push(root);
  const folder = join(root, "billing");
  mkdirSync(folder, { recursive: true });
  const dataDir = join(root, "data");
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "billing", root: folder });
  const author = { kind: "agent" as const, host: "claude-code", session: `perm:${SESSION}`, name: "Claude Code" };
  const first = store.sendMessage({ project_id: project.id, author, permission: true, body: CARD, idempotency_key: "perm-req-00000001" }).message;
  const second = store.sendMessage({ project_id: project.id, author, permission: true, body: CARD, reply_to: first.id, idempotency_key: "perm-req-00000002" }).message;
  // Pairing never reaches the real relay: a port nothing listens on (restored after each test).
  relayBefore = process.env.PLANNOTATOR_RELAY_URL;
  process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: true });
  servers.push(server);
  return { server, thread: first.thread_id, first: first.id, second: second.id };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function questionOf(server: InboxServer, messageId: string, threadId: string) {
  const read = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as {
    thread: { id: string; messages: { id: string; questions?: { key: string; revision: number; prompt: string; state: string }[] }[] };
  };
  return read.thread.messages.find((m) => m.id === messageId)!.questions![0]!;
}

function replyBody(server: InboxServer, q: { key: string; revision: number; prompt: string }, key: string, withSession = true) {
  return {
    ...(withSession ? { serverSession: server.serverSession } : {}),
    idempotency_key: key,
    questions: [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["Allow once"] } }],
  };
}

const post = (server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("answering a permission question", () => {
  test("a local call with no page Origin is refused (reply and picks), and nothing is written", async () => {
    const { server, thread, first } = await setup();
    const q = await questionOf(server, first, thread);
    const reply = await post(server, `/api/inbox/messages/${first}/reply`, replyBody(server, q, "00000000-0000-4000-8000-000000000101"));
    expect(reply.status).toBe(403);
    expect(((await reply.json()) as { code: string }).code).toBe("window_only");
    const picks = await post(server, `/api/inbox/messages/${first}/picks`, { serverSession: server.serverSession, questions: replyBody(server, q, "x").questions });
    expect(picks.status).toBe(403);
    expect((await questionOf(server, first, thread)).state).toBe("open");
  });

  test("Re-ask is refused on a permission question, even from the window, and its unsent pick stays unsent", async () => {
    const { server, thread, first, second } = await setup();
    const origin = { Origin: base(server) };
    const q = await questionOf(server, first, thread);
    // The person picked Allow once on the first and did not send it.
    const picked = await post(server, `/api/inbox/messages/${first}/picks`, { serverSession: server.serverSession, questions: replyBody(server, q, "x").questions }, origin);
    expect(picked.status).toBe(200);
    const reask = await post(server, `/api/inbox/messages/${second}/reask`, { serverSession: server.serverSession, idempotency_key: "00000000-0000-4000-8000-000000000102" }, origin);
    expect(reask.status).toBe(422);
    expect((await questionOf(server, first, thread)).state).toBe("picked");
  });

  test("the window answers: its own Origin and this run's serverSession", async () => {
    const { server, thread, first } = await setup();
    const q = await questionOf(server, first, thread);
    const reply = await post(server, `/api/inbox/messages/${first}/reply`, replyBody(server, q, "00000000-0000-4000-8000-000000000103"), { Origin: base(server) });
    expect(reply.status).toBe(200);
    expect((await questionOf(server, first, thread)).state).toBe("sent");
  });

  test("the person's paired phone answers through the device door (no Origin, its token); without the token, nothing", async () => {
    const { server, thread, first } = await setup();
    const q = await questionOf(server, first, thread);
    const made = (await (await post(server, "/api/inbox/pairing", {})).json()) as { offer: { code: string } };
    const paired = (await (await post(server, "/api/inbox/device/pair", { code: made.offer.code, name: "iPhone", platform: "ios" })).json()) as { token: string };
    const body = replyBody(server, q, "00000000-0000-4000-8000-000000000104", false);
    const refused = await post(server, `/api/inbox/device/messages/${first}/reply`, body);
    expect(refused.status).toBe(401);
    expect((await questionOf(server, first, thread)).state).toBe("open");
    const door = await post(server, `/api/inbox/device/messages/${first}/reply`, body, { Authorization: `Bearer ${paired.token}` });
    expect(door.status).toBe(200);
    expect((await questionOf(server, first, thread)).state).toBe("sent");
  });
});
