/** Export decisions' route on a real Inbox in a temp folder. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function seed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-decision-export-")));
  roots.push(root);
  const project = join(root, "acme-notes");
  mkdirSync(join(project, "mock"), { recursive: true });
  writeFileSync(join(project, "mock", "small.png"), PNG);
  writeFileSync(join(project, "mock", "huge.png"), Buffer.concat([PNG, Buffer.alloc(450 * 1024, 7)]));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  let clock = Date.parse("2026-11-10T07:30:00Z");
  const store = InboxStore.open(data, { now: () => new Date((clock += 60_000)) });
  const p = store.ensureProject({ name: "acme-notes", root: project });
  const author = { kind: "agent" as const, host: "claude-code", session: "ses-a", name: null };
  const body = ":::question\nHow should a conflict show?\n\n- [ ] Banner — ![Yellow banner](mock/small.png)\n- [ ] Panel — ![Side panel](mock/huge.png)\n\nRecommended: Banner\n:::";
  const sent = store.sendMessage({ project_id: p.id, author, body, thread: "t", idempotency_key: "k1", subject: "Offline sync: conflicts" }).message;
  const q = store.questionsOf(sent.id)[0]!;
  store.savePicks(sent.id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["Banner"] } }]);
  const after = store.questionsOf(sent.id)[0]!;
  store.sendReply(sent.id, { questions: [{ key: after.key, revision: after.revision }], idempotency_key: "r1" });
  return { data, thread: sent.thread_id };
}

async function start(data: string, options: { phones?: boolean } = {}) {
  const server = await startInboxServer({ dataDir: data, ...options });
  servers.push(server);
  return server;
}
const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

test("Markdown and HTML download as attachments named by subject and the reader's date; HTML embeds the picture within its cap", async () => {
  const world = seed();
  const server = await start(world.data);
  const md = await fetch(`${base(server)}/api/inbox/threads/${world.thread}/decisions?format=md&tz=Asia/Tokyo`);
  expect(md.status).toBe(200);
  expect(md.headers.get("content-type")).toStartWith("text/markdown");
  const mdName = /filename="([^"]+)"/.exec(md.headers.get("content-disposition") ?? "")?.[1];
  expect(md.headers.get("content-disposition")).toStartWith("attachment;");
  const dayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  expect(mdName).toBe(`decisions-offline-sync-conflicts-${dayIn("Asia/Tokyo")}.md`);
  expect((await md.text()).split("\n")[0]).toBe(`<!-- plannotator-decisions v1 thread=${world.thread} -->`);

  const html = await fetch(`${base(server)}/api/inbox/threads/${world.thread}/decisions?format=html&tz=America/Los_Angeles`);
  expect(html.status).toBe(200);
  expect(html.headers.get("content-disposition")).toStartWith(`attachment; filename="decisions-offline-sync-conflicts-${dayIn("America/Los_Angeles")}.html"`);
  // Opened in place by mistake, it runs nothing on the Inbox's origin.
  expect(html.headers.get("content-security-policy")).toStartWith("sandbox");
  const page = await html.text();
  const srcs = [...page.matchAll(/<img [^>]*?src="([^"]+)"/g)].map((m) => m[1]!);
  expect(srcs).toEqual([`data:image/png;base64,${PNG.toString("base64")}`]);
  expect(page).toContain('<span class="noimg">Side panel</span>');

  const json = await fetch(`${base(server)}/api/inbox/threads/${world.thread}/decisions?format=json`);
  const doc = (await json.json()) as { format: string; counts: { decided: number }; images: Record<string, string> };
  expect([doc.format, doc.counts.decided, Object.keys(doc.images).length]).toEqual(["plannotator.decisions", 1, 1]);
});

test("another site, a missing thread and an unknown format are refused", async () => {
  const world = seed();
  const server = await start(world.data);
  const url = `${base(server)}/api/inbox/threads/${world.thread}/decisions`;
  expect((await fetch(url, { headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(`${base(server)}/api/inbox/threads/msg_01M62DTT05NJ59ZR4AJCDJ70XK/decisions`)).status).toBe(404);
  expect((await fetch(`${url}?format=pdf`)).status).toBe(422);
  expect((await fetch(url, { method: "POST" })).status).toBe(405);
});

test("the phone door carries it (a linked machine's forward goes through the same door)", async () => {
  const world = seed();
  const server = await start(world.data, { phones: true });
  const made = (await (await fetch(`${base(server)}/api/inbox/pairing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession }) })).json()) as { offer: { code: string } };
  const paired = await fetch(`${base(server)}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
  const { token } = (await paired.json()) as { token: string };
  const read = await fetch(`${base(server)}/api/inbox/device/threads/${world.thread}/decisions?format=md`, { headers: { Authorization: `Bearer ${token}` } });
  expect(read.status).toBe(200);
  expect(read.headers.get("content-disposition")).toStartWith("attachment;");
  expect((await read.text()).startsWith("<!-- plannotator-decisions v1")).toBe(true);
});
