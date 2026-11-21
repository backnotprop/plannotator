/**
 * A paired cloud agent gets what a local agent gets (the owner, 2026-11-21: "They need to have the same access as a
 * local agent to the inbox"), through the agent door (inbox-agent-door.ts) on a store, with no Inbox running and no
 * server: the door's own handler, a stub device and pairing. The failures these guard: a picture in the body refused
 * (or read from the person's disk), a card call aimed at the agent's own place instead of the card's project, a
 * repository's git address not finding its project (or making a new one), a routine refused, a walkthrough refused
 * or read from nowhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxGitRemoteKey } from "@plannotator/core/inbox-git-url";
import { INBOX_CARD_ACTION_ON, type InboxProject } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxAgentDoor } from "./inbox-agent-door";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import type { InboxMcpContext } from "./inbox-mcp";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const TOKEN = `tok_${"A".repeat(43)}`;
type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, any> };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(mcp: Partial<InboxMcpContext> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-door-parity-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const ledgerRoot = join(root, "ledger");
  mkdirSync(join(ledgerRoot, "src"), { recursive: true });
  writeFileSync(join(ledgerRoot, "src", "pay.ts"), "export const pay = 1;\nexport const refund = 2;\n");
  writeFileSync(join(ledgerRoot, "secret.png"), PNG);
  const ledger = store.ensureProject({ name: "ledger", root: ledgerRoot });
  const agent: InboxCloudAgent = { session: "cloud.0123456789ab", name: "Fixer", preset: "other", url: null, key: null, project_id: null, created_at: "2026-11-21T00:00:00.000Z", key_set_at: null, key_rejected_at: null, device_id: "dev_1" };
  const place = join(store.dir, "cloud-agents", agent.session, "Fixer");
  mkdirSync(place, { recursive: true });
  const agents = {
    byDevice: (id: string) => (id === "dev_1" ? agent : null),
    homeRoot: () => place,
    home: () => store.ensureProject({ name: "Fixer", root: place }),
    homeName: () => "Fixer",
    seen: () => {},
  } as unknown as InboxCloudAgents;
  const device = { id: "dev_1", revoked_at: null };
  const devices = { byToken: (token: string) => (token === TOKEN ? device : null), byId: () => device, isOtherDevice: () => false, touch: () => {} };
  const door = createInboxAgentDoor({
    store,
    agents,
    devices: () => devices as never,
    mcp: {
      store,
      baseUrl: () => "http://localhost:1/",
      resolveProject: async () => ledger,
      branches: { on: () => false, projectOfRemote: (url: string) => (inboxGitRemoteKey(url) === "github.com/acme/ledger" ? ledger : null) } as never,
      ...mcp,
    } as InboxMcpContext,
  });
  const call = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
    const response = await door.handle(new Request("http://127.0.0.1/api/inbox/agent/call", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ tool, arguments: args }) }));
    return ((await response.json()) as { result: Result }).result;
  };
  const error = (result: Result) => (result.isError ? result.content[0]!.text : null);
  return { root, store, ledger, agent, place, call, error };
}

describe("pictures in a cloud agent's message", () => {
  test("![alt](name) shows the file attached in the same send, in the body and not again below it", async () => {
    const w = world();
    const sent = await w.call("send_message", { project: "ledger", body: "The chart: ![chart](./chart.png)", attachments: [{ name: "chart.png", data: PNG.toString("base64") }, { name: "notes.md", data: Buffer.from("# n\n").toString("base64") }] });
    expect(w.error(sent)).toBeNull();
    const message = w.store.message(sent.structuredContent!.message_id as string)!;
    expect(message.inline_images!.map((image) => [image.ref, image.name, image.size])).toEqual([["./chart.png", "chart.png", PNG.length]]);
    expect(message.attachments!.map((attachment) => attachment.name)).toEqual(["notes.md"]);
  });

  test("a picture that names no file attached in the send is refused, never read from the project's folder, and nothing is written", async () => {
    const w = world();
    const before = w.store.listProjects().length;
    const refused = await w.call("send_message", { project: "ledger", body: "See ![it](secret.png)", attachments: [{ name: "other.png", data: PNG.toString("base64") }] });
    expect(w.error(refused)).toStartWith("image_path_refused:");
    const notPicture = await w.call("send_message", { project: "ledger", body: "See ![it](notes.md)", attachments: [{ name: "notes.md", data: Buffer.from("# n\n").toString("base64") }] });
    expect(w.error(notPicture)).toStartWith("image_not_shown:");
    expect(w.store.listProjects().length).toBe(before);
    expect(w.store.listRows().length).toBe(0);
  });
});

describe("a repository named by its git address", () => {
  test("finds its project for a new thread and a list, in any form of the address; an address no project has is not found and makes nothing", async () => {
    const w = world();
    for (const address of ["https://github.com/acme/ledger", "git@github.com:acme/ledger.git"]) {
      const sent = await w.call("send_message", { project: address, subject: `Via ${address}`, body: "Hello." });
      expect(w.error(sent)).toBeNull();
      expect(w.store.message(sent.structuredContent!.message_id as string)!.project_id).toBe(w.ledger.id);
    }
    const listed = await w.call("read_thread", { project: "https://github.com/acme/ledger", asked_by: "anyone" });
    expect(listed.structuredContent!.project.id).toBe(w.ledger.id);
    const projects = w.store.listProjects().length;
    expect(w.error(await w.call("send_message", { project: "https://github.com/acme/elsewhere", body: "Hello." }))).toStartWith("project_not_found:");
    expect(w.store.listProjects().length).toBe(projects);
  });
});

describe.if(INBOX_CARD_ACTION_ON)("a cloud agent's cards", () => {
  test("a card_id call uses the card's own project, a create with thread_id the thread's, and list with no project covers every project", async () => {
    const w = world({ boardOn: () => true });
    const local = w.store.sendMessage({ project_id: w.ledger.id, author: { kind: "agent", host: "pi", session: "ses-pi", name: "Pi" }, body: "Ledger work.", subject: "Ledger" }).message;
    const made = await w.call("card", { op: "create", thread_id: local.thread_id, title: "Ledger fix" });
    expect(w.error(made)).toBeNull();
    const cardId = made.structuredContent!.card.id as string;
    expect(w.store.card(cardId)!.project_id).toBe(w.ledger.id);
    // Its own place has a Board once it has a thread there.
    await w.call("send_message", { body: "My own note." });
    const own = await w.call("card", { op: "create", title: "Own work" });
    expect(w.error(own)).toBeNull();
    expect(w.error(await w.call("card", { op: "move", card_id: cardId, column: "in_progress" }))).toBeNull();
    expect(w.store.card(cardId)!.column).toBe("in_progress");
    const listed = await w.call("card", { op: "list" });
    expect((listed.structuredContent!.cards as { id: string }[]).map((card) => card.id).sort()).toEqual([cardId, own.structuredContent!.card.id].sort());
  });
});

describe("routines and walkthroughs", () => {
  test("a routine reaches the routine tool while the person has Routines on, a create with no folder in a new scratch folder; its files are refused", async () => {
    const created: Record<string, unknown>[] = [];
    const scheduled = {
      list: () => [],
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        throw Object.assign(new Error("stop here"), { code: "validation_error" });
      },
    };
    const off = world();
    expect(off.error(await off.call("routine", { op: "list" }))).toStartWith("tool_not_allowed:");
    const w = world({ scheduledOn: () => true, scheduled: () => scheduled as never });
    expect((await w.call("routine", { op: "list" })).content[0]!.text).toBe("No routines.");
    await w.call("routine", { op: "create", name: "Triage", prompt: "Triage.", agent: "claude-code" });
    expect(created.map((input) => input.folder)).toEqual([{ scratch: true }]);
    await w.call("routine", { op: "create", name: "Triage", prompt: "Triage.", agent: "claude-code", project: "ledger" });
    expect(created.at(-1)!.folder).toEqual({ path: w.ledger.root });
    expect(w.error(await w.call("routine", { op: "create", name: "T", prompt: "T.", attachments: ["/etc/hosts"] }))).toStartWith("attachment_path_refused:");
  });

  test("a walkthrough reads the named project's checkout on this computer; with no checkout it says so", async () => {
    let walkthroughThread = "";
    const w = world({ codeReviewOn: () => true, walkthroughThread: (id) => id === walkthroughThread });
    const guide = { title: "Pay", intent: "How pay works.", sections: [{ title: "Pay", overview: "The constants.", diffs: [{ file: "src/pay.ts", lines: "1-2", summary: "Both constants." }] }] };
    expect(w.error(await w.call("submit_guide", { guide, walkthrough: true }))).toStartWith("no_checkout:");
    const sent = await w.call("submit_guide", { guide, walkthrough: true, project: "ledger" });
    expect(w.error(sent)).toBeNull();
    expect(w.store.message(sent.structuredContent!.message_id as string)!.guide!.walkthrough).toBe(true);
    // A guide sent into a thread the New review box started as a walkthrough is one, as a local agent's is.
    const started = w.store.sendMessage({ project_id: w.ledger.id, author: { kind: "person" }, body: "Walk me through pay.", subject: "Walkthrough" }).message;
    walkthroughThread = started.thread_id;
    const reply = await w.call("submit_guide", { guide, reply_to: started.id });
    expect(w.error(reply)).toBeNull();
    expect(w.store.message(reply.structuredContent!.message_id as string)!.guide!.walkthrough).toBe(true);
    // Nothing was read from the agent's own place.
    expect(readdirSync(w.place)).toEqual([]);
  });
});
