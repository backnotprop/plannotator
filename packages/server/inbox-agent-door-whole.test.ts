import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxCloudAgentView } from "@plannotator/core/inbox-cloud";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { decodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import { cloudAgentsPath } from "./inbox-cloud-agents";
import { doorCleanups, doorWorld } from "../../tests/helpers/inbox-agent-door-world";

const cleanups = doorCleanups();
afterEach(() => cleanups.run());

type Thread = { thread_id: string };

async function rows(w: Awaited<ReturnType<typeof doorWorld>>) {
  const list = (await w.call("/api/inbox/threads")).json as { sections: { threads: InboxListRow[] }[] };
  return list.sections.flatMap((section) => section.threads);
}

describe("a cloud agent uses the whole Inbox", () => {
  test("it lists, reads, searches, names, replies in and resolves a thread another agent started in another project", async () => {
    const w = await doorWorld(cleanups);
    const { agent, pairing } = await w.pair();
    const { local } = w;

    const all = await w.door(pairing.token, "read_thread", { asked_by: "anyone" });
    expect((all.result!.structuredContent!.threads as (Thread & { project: string })[]).find((t) => t.thread_id === local.thread_id)?.project).toBe("ledger");
    expect(all.result!.content[0]!.text).toContain(`${local.thread_id} · in ledger`);
    const read = await w.door(pairing.token, "read_thread", { thread_id: local.thread_id });
    expect(read.result!.content[0]!.text).toContain("Private plan: the zebra launch.");
    const found = await w.door(pairing.token, "search", { query: "zebra" });
    expect((found.result!.structuredContent!.results as Thread[]).map((r) => r.thread_id)).toContain(local.thread_id);

    const replied = await w.door(pairing.token, "send_message", { reply_to: local.message_id, body: "I can take the zebra launch." });
    expect(replied.error).toBeNull();
    expect(replied.result!.structuredContent!.thread_id).toBe(local.thread_id);
    const byName = await w.door(pairing.token, "send_message", { project: "ledger", thread: "launch plan", body: "Joined by its name." });
    expect(byName.result!.structuredContent!.thread_id).toBe(local.thread_id);
    const messages = (await w.thread(local.thread_id)).messages;
    expect(messages.slice(1).map((m) => [m.body, m.author])).toEqual([
      ["I can take the zebra launch.", { kind: "agent", host: "cloud-grok", session: agent.session, name: "Nightly fixer" }],
      ["Joined by its name.", { kind: "agent", host: "cloud-grok", session: agent.session, name: "Nightly fixer" }],
    ]);

    expect((await w.door(pairing.token, "snooze_thread", { thread_id: local.thread_id, until: null })).error).toBeNull();
    expect((await w.door(pairing.token, "thread_pulls", { thread_id: local.thread_id })).error).toBeNull();
    expect((await w.door(pairing.token, "get_guide_brief")).error).toBeNull();
    expect((await w.door(pairing.token, "resolve_message", { message_id: local.message_id })).error).toBeNull();
    expect((await w.thread(local.thread_id)).resolved_at).not.toBeNull();
  });

  test("a reply it reads through the door counts as read: the person can no longer take it back", async () => {
    const w = await doorWorld(cleanups);
    const paired = await w.call("/api/inbox/cloud-agents", { name: "Poller", preset: "other" });
    const pairing = decodeInboxAgentPairing(paired.json.pairing)!;
    const asked = (await w.door(pairing.token, "send_message", { project: "ledger", subject: "Runner", body: "Which runner?" })).result!.structuredContent as { thread_id: string; message_id: string };
    const replyIn = async (words: string, key: string) => {
      expect((await w.call(`/api/inbox/messages/${asked.message_id}/reply`, { words, idempotency_key: key })).status).toBe(200);
      return (await w.thread(asked.thread_id)).messages.filter((m) => m.author.kind === "person").at(-1)!.id;
    };
    const early = await replyIn("Use ARM.", "tb-1");
    expect((await w.call(`/api/inbox/messages/${early}/take-back`, {})).status).toBe(200);
    const late = await replyIn("Use x86.", "tb-2");
    const read = await w.door(pairing.token, "read_thread", { thread_id: asked.thread_id });
    expect(read.result!.content[0]!.text).toContain("Use x86.");
    expect(read.result!.content[0]!.text).not.toContain("Use ARM.");
    expect(await w.call(`/api/inbox/messages/${late}/take-back`, {})).toMatchObject({ status: 409, json: { code: "agent_has_it", by: "read" } });
  });

  test("it starts a thread in a project it names; with none named, in a place of its own named after it, apart from another agent of the same name", async () => {
    const w = await doorWorld(cleanups);
    const books = join(w.root, "books");
    mkdirSync(books);
    const booksThread = await w.localSend({ body: "Quarter close.", project_path: books, idempotency_key: "b1" });
    const first = await w.pair("grok-bot", "Nightly fixer");
    const second = await w.pair("other", "Nightly fixer");

    const who = await w.door(first.pairing.token, "whoami");
    expect(who.result!.structuredContent).toMatchObject({ name: "Nightly fixer", project: "Nightly fixer" });
    expect(who.result!.structuredContent!.projects).toEqual(expect.arrayContaining(["ledger", "books"]));

    const named = await w.door(first.pairing.token, "send_message", { project: "Books", subject: "Close", body: "The quarter closes Friday." });
    const namedThread = named.result!.structuredContent!.thread_id as string;
    expect((await w.thread(namedThread)).messages[0]!.project_id).toBe((await w.thread(booksThread.thread_id)).messages[0]!.project_id);
    expect((await w.door(first.pairing.token, "send_message", { project: "nowhere", body: "Lost." })).error).toStartWith("project_not_found:");

    const own = await w.door(first.pairing.token, "send_message", { subject: "Nightly", body: "Nightly run finished." });
    const other = await w.door(second.pairing.token, "send_message", { subject: "Nightly", body: "Mine finished too." });
    const listed = await rows(w);
    const placeOf = (id: string) => listed.find((row) => row.thread_id === id)!.project;
    const [a, b] = [placeOf(own.result!.structuredContent!.thread_id), placeOf(other.result!.structuredContent!.thread_id)];
    expect(a.id).not.toBe(b.id);
    expect(a.name).not.toBe(b.name);
    expect([a.name, b.name].every((name) => name.startsWith("Nightly fixer"))).toBe(true);
    const again = (await w.door(first.pairing.token, "send_message", { subject: "Again", body: "Second run." })).result!.structuredContent!.thread_id as string;
    expect((await rows(w)).find((row) => row.thread_id === again)!.project.id).toBe(a.id);
  });

  test("an agent paired under the old record, with one project, works after the upgrade with nothing to do: that project is where its new threads go", async () => {
    const w = await doorWorld(cleanups);
    const { agent, pairing } = await w.pair();
    const ledger = (await w.thread(w.local.thread_id)).messages[0]!.project_id;
    const file = JSON.parse(readFileSync(cloudAgentsPath(w.dataDir), "utf8")) as { agents: Record<string, unknown>[] };
    writeFileSync(cloudAgentsPath(w.dataDir), JSON.stringify({ ...file, agents: file.agents.map((a) => ({ ...a, project_id: ledger })) }));
    await w.restart();

    expect((await w.door(pairing.token, "whoami")).result!.structuredContent).toMatchObject({ project: "ledger" });
    const sent = await w.door(pairing.token, "send_message", { subject: "Nightly", body: "Still here." });
    expect((await w.thread(sent.result!.structuredContent!.thread_id)).messages[0]!.project_id).toBe(ledger);
    expect((await w.door(pairing.token, "read_thread", { thread_id: w.local.thread_id })).error).toBeNull();
    const view = ((await w.call("/api/inbox/cloud-agents")).json.agents as InboxCloudAgentView[]).find((a) => a.session === agent.session)!;
    expect(view.project?.id).toBe(ledger);
  });

  test("a question's prototype is a page it attaches or an https address; an address on a computer is refused, saying what works", async () => {
    const w = await doorWorld(cleanups);
    const { pairing } = await w.pair();
    const page = Buffer.from("<!doctype html><title>Mock</title><p>New pricing</p>").toString("base64");
    const ask = (prototype: string) => `:::question\nShip the new pricing page?\n- [ ] Yes\n    Prototype: ${prototype}\n- [ ] No\n:::`;
    const sent = await w.door(pairing.token, "send_message", { subject: "Pricing", body: ask("mock.html"), attachments: [{ name: "mock.html", data: page }] });
    expect(sent.error).toBeNull();
    const message = (await w.thread(sent.result!.structuredContent!.thread_id as string)).messages[0]!;
    expect(message.attachments!.map((a) => [a.name, a.kind])).toEqual([["mock.html", "html"]]);
    const web = await w.door(pairing.token, "send_message", { subject: "Pricing", body: ask("https://preview.example.com/pricing") });
    expect(web.error).toBeNull();
    const webMessage = (await w.thread(web.result!.structuredContent!.thread_id as string)).messages[0]!;
    expect(webMessage.live_sites!.map((site) => [site.url, site.web])).toEqual([["https://preview.example.com/pricing", true]]);
    for (const address of ["http://localhost:3000/", "http://preview.example.com/pricing"]) {
      const refused = (await w.door(pairing.token, "send_message", { subject: "Pricing", body: ask(address) })).error;
      expect(refused).toContain(`Prototype: ${address}:`);
      expect(refused).toContain("https://");
    }
  });
});
