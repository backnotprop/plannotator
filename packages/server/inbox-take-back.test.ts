import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { composeInboxSkillsBlock } from "@plannotator/core/inbox-skills-compose";
import { PULL_DETAILS_START, PULL_THREAD_STEP, type InboxDraft, type InboxMessage, type InboxPull, type InboxReplyDraft } from "@plannotator/core/inbox-types";
import { INBOX_MESSAGE_SKILL_AUDIENCE, INBOX_REPLY_SKILL_AUDIENCE, splitInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { linkInboxPulls, type InboxPullLinkStore } from "./inbox-pulls";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world(existing?: { root: string }) {
  const root = existing?.root ?? realpathSync(mkdtempSync(join(tmpdir(), "plannotator-take-back-")));
  if (!existing) roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, binaryPath: null });
  servers.push(server);
  const client = new Client({ name: "take-back", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}/api/inbox`;
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const ask = async (session: string, body: string) =>
    (
      await client.callTool({
        name: "send_message",
        arguments: { body, project_path: project, agent_session: session, agent_host: "pi", agent_name: "Pi" },
        _meta: { [INBOX_WAKES_META_KEY]: true },
      })
    ).structuredContent as { message_id: string; thread_id: string };
  const reply = async (messageId: string, key: string, words: string, uploads: string[] = [], more: Record<string, unknown> = {}) =>
    ((await (await post(`messages/${messageId}/reply`, { idempotency_key: key, words, uploads, ...more })).json()) as { reply: InboxMessage }).reply.id;
  const upload = async (name: string, text: string) =>
    ((await (await fetch(`${base}/uploads?name=${name}`, { method: "POST", body: text })).json()) as { upload: { upload_id: string } }).upload.upload_id;
  const takeBack = async (id: string) => {
    const response = await post(`messages/${id}/take-back`, {});
    const body = (await response.json()) as { message?: InboxMessage; draft?: InboxReplyDraft | null; compose?: InboxDraft | null; code?: string; by?: string };
    return { status: response.status, ...body };
  };
  const wake = (session: string, delivered: string[], probeMs = 0) => {
    const link = new InboxWake(
      new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [] }),
      session,
      {
        isBusy: async () => {
          if (probeMs > 0) await Bun.sleep(probeMs);
          return false;
        },
        deliver: async (_text, command) => {
          delivered.push(command.id);
          await Bun.sleep(40);
        },
        notify: () => {},
        projectPath: () => project,
      },
      5,
    );
    link.start();
    stops.push(() => link.dispose());
  };
  return { root, server, client, ask, reply, upload, takeBack, wake };
}

/** The sentence the store writes after a reply's words while the one question asked is open, for the agent only. */
const STILL_OPEN = "No question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.";
const QUESTION = ":::question\nWhich runner?\n\n- [ ] ARM\n- [ ] x86\n:::";
const times = (text: string, part: string) => text.split(part).length - 1;
/** The same sentence once an earlier reply answered one of the questions (the owner's report, 0.29.0). */
const NO_NEW_ANSWERS = "No new answers in this reply; 1 question is still open. Don't re-ask it; the person will answer in the Inbox.";
const PR_REPO = "acme/api";
const PR = {
  key: `github.com/${PR_REPO}#7`,
  platform: "github",
  host: "github.com",
  repo: PR_REPO,
  number: 7,
  url: `https://github.com/${PR_REPO}/pull/7`,
  title: "Rename the ledger",
  author: "tomas",
  mine: false,
  requested: true,
  state: "open",
  base: "main",
  head: "fix/7",
  head_repo: PR_REPO,
  additions: 1,
  deletions: 0,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: "success",
  updated_at: "2026-11-03T09:00:00.000Z",
  merged_at: null,
} as InboxPull;
/** A PR page's Start a thread details, as the window writes them (`pullHandoffMessage`, a single PR). */
const PR_DETAILS = `${PULL_DETAILS_START}pull request. Don't change any code unless I explicitly tell you to.\n\nPull request\n- Title: Rename the ledger\n- Number: #7\n- Repository: ${PR_REPO}\n- Link: https://github.com/${PR_REPO}/pull/7\n- Branch: fix/7, into main\n- Author: tomas\n\nWhat to do\n${PULL_THREAD_STEP} Bring up what you notice.`;

describe("take back", () => {
  test("puts the words above the box's draft with their files, and the agent never gets it; once it has one, it is refused", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", "Which runner?");
    w.server.store.saveReplyDraft(asked.thread_id, { body: "Also run it twice.", base: null });
    const file = await w.upload("plan.md", "# Plan");
    const id = await w.reply(asked.message_id, "k1", "Use the ARM runner.", [file]);
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toBe("Use the ARM runner.\n\nAlso run it twice.");
    expect(taken.draft?.files?.map((f) => f.name)).toEqual(["plan.md"]);
    const delivered: string[] = [];
    w.wake("ses-a", delivered);
    const next = await w.reply(asked.message_id, "k2", "Use the ARM runner, twice.");
    for (let i = 0; i < 200 && !delivered.includes(next); i++) await Bun.sleep(20);
    expect(delivered).toEqual([next]);
    for (let i = 0; i < 100 && !w.server.store.message(next)?.delivery; i++) await Bun.sleep(20);
    const late = await w.takeBack(next);
    expect(late).toMatchObject({ status: 409, code: "agent_has_it" });
    expect(w.server.store.message(next)?.taken_back_at ?? null).toBeNull();
  }, 30_000);

  test("a thread the person started with only that message comes back as a New message", async () => {
    const w = await world();
    await w.ask("ses-a", "Ready.");
    const project = w.server.store.listProjects()[0]!;
    const started = w.server.store.startPersonThread({ project_id: project.id, body: "Rename the ledger.", to: { host: "pi", session: "ses-a" }, idempotency_key: "k1" }).message;
    const taken = await w.takeBack(started.id);
    expect(taken.status).toBe(200);
    expect(taken.compose).toMatchObject({ body: "Rename the ledger.", to: { host: "pi", session: "ses-a" } });
  }, 30_000);

  test("a reply that answers no open question comes back as the person's words alone; sent again, the agent reads the still-open line once", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", QUESTION);
    const id = await w.reply(asked.message_id, "k1", "Later.");
    expect(w.server.store.message(id)?.body).toBe(`Later.\n\n${STILL_OPEN}`);
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toBe("Later.");
    // What the agent reads (read_thread gives the stored body): the store's sentence, once.
    const again = await w.reply(asked.message_id, "k2", taken.draft!.body);
    expect(times(w.server.store.message(again)!.body, STILL_OPEN)).toBe(1);
  }, 30_000);

  test("a reply that quotes a message comes back with the quote, its lead out of the words", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", "Which runner should the nightly build use?");
    const id = await w.reply(asked.message_id, "k1", "Later.", [], { quote: { of: asked.message_id } });
    expect(w.server.store.message(id)?.body).toStartWith("Replying to your message");
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toBe("Later.");
    expect(taken.draft?.quote).toEqual({ of: asked.message_id });
  }, 30_000);

  test("a quoting reply taken back into a draft the box kept keeps the quote's lead as words: the quote is never lost", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", "Which runner should the nightly build use?");
    w.server.store.saveReplyDraft(asked.thread_id, { body: "Also run it twice.", base: null });
    const id = await w.reply(asked.message_id, "k1", "Later.", [], { quote: { of: asked.message_id } });
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toStartWith("Replying to your message");
    expect(taken.draft?.body).toEndWith("Later.\n\nAlso run it twice.");
  }, 30_000);

  test("a reply naming a skill comes back with the skill's name in the words and without the skills block", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", QUESTION);
    const skills = composeInboxSkillsBlock([{ name: "write-better", root: "claude", humanOnly: false }], new Map(), INBOX_REPLY_SKILL_AUDIENCE);
    const id = await w.reply(asked.message_id, "k1", "Tighten it with $write-better.", [], { feedback: skills });
    expect(splitInboxSkillsBlock(w.server.store.message(id)!.body)).not.toBeNull();
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toBe("Tighten it with $write-better.");
  }, 30_000);

  test("a thread started from a pull request's page comes back with the PR's details after the words, without the skills block; sent again, it is that PR's thread again", async () => {
    const w = await world();
    await w.ask("ses-a", "Ready.");
    const project = w.server.store.listProjects()[0]!;
    const to = { host: "pi", session: "ses-a" };
    const skills = composeInboxSkillsBlock([{ name: "write-better", root: "claude", humanOnly: false }], new Map(), INBOX_MESSAGE_SKILL_AUDIENCE);
    const words = "Look at the ledger with $write-better.";
    const started = w.server.store.startPersonThread({ project_id: project.id, body: `${words}\n\n${PR_DETAILS}\n\n${skills}`, to, idempotency_key: "k1" }).message;
    const store = w.server.store;
    const links: InboxPullLinkStore = {
      threadsOf: (id) => store.threadsOf(id),
      threadMessageIds: (id) => store.threadMessageIds(id),
      message: (id) => store.message(id),
      threadSubject: (id) => store.threadSubject(id),
      threadProject: (id) => (store.message(id)?.thread_id === id ? store.message(id)!.project_id : null),
    };
    const link = () => linkInboxPulls([PR], links, new Map([[`github.com/${PR_REPO}`, [project.id]]]))[PR.key];
    expect(link()?.thread_id).toBe(started.thread_id);
    const taken = await w.takeBack(started.id);
    expect(taken.status).toBe(200);
    expect(taken.compose?.body).toBe(`${words}\n\n${PR_DETAILS}`);
    expect(link()).toBeUndefined();
    // Sent again from the New message (its Send adds the skills block again): the PR's own thread again.
    const again = store.startPersonThread({ project_id: project.id, body: `${taken.compose!.body}\n\n${skills}`, to, idempotency_key: "k2" }).message;
    expect(link()).toMatchObject({ via: "owner", ask: "thread", page: true, thread_id: again.thread_id });
  }, 30_000);

  test("the owner's case: one question answered, one still open, a reply that answers nothing comes back as its words; sent again, the agent reads the still-open line once", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", `${QUESTION}\n\n:::question\nShip tonight?\n\n- [ ] Yes\n- [ ] No\n:::`);
    const [first] = w.server.store.questionsOf(asked.message_id);
    await w.reply(asked.message_id, "k0", "", [], { questions: [{ key: first!.key, revision: 0, answer: { v: 1, key: first!.key, kind: first!.kind, prompt: first!.prompt, selected: ["ARM"] } }] });
    const id = await w.reply(asked.message_id, "k1", "Later.");
    expect(w.server.store.message(id)?.body).toBe(`Later.\n\n${NO_NEW_ANSWERS}`);
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toBe("Later.");
    const again = await w.reply(asked.message_id, "k2", taken.draft!.body);
    expect(times(w.server.store.message(again)!.body, NO_NEW_ANSWERS)).toBe(1);
  }, 30_000);

  test("a reply of only a file while a question is open, taken back into a draft the box kept: the draft's words as they were, no blank lines before them", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", QUESTION);
    w.server.store.saveReplyDraft(asked.thread_id, { body: "Also run it twice.", base: null });
    const file = await w.upload("plan.md", "# Plan");
    const id = await w.reply(asked.message_id, "k1", "", [file]);
    expect(w.server.store.message(id)?.body).toBe(STILL_OPEN);
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toBe("Also run it twice.");
    expect(taken.draft?.files?.map((f) => f.name)).toEqual(["plan.md"]);
  }, 30_000);

  test("another agent's read of the thread before the wake hands it over", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", "Which runner?");
    const id = await w.reply(asked.message_id, "k1", "Use the ARM runner.");
    await w.client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-b" } });
    expect(await w.takeBack(id)).toMatchObject({ status: 409, code: "agent_has_it", by: "read" });
  }, 30_000);

  test("an agent's read still refuses a take-back after the Inbox restarts", async () => {
    const first = await world();
    const asked = await first.ask("ses-a", "Which runner?");
    const id = await first.reply(asked.message_id, "k1", "Use the ARM runner.");
    await first.client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-b" } });
    await first.client.close();
    first.server.stop();
    const again = await world({ root: first.root });
    expect(await again.takeBack(id)).toMatchObject({ status: 409, code: "agent_has_it", by: "read" });
  }, 30_000);

  test("racing the shared connection's claim, a reply is never both taken back and delivered", async () => {
    const w = await world();
    const delivered: string[] = [];
    w.wake("ses-race", delivered, 30);
    const asked = await w.ask("ses-race", "Which runner?");
    let takenBack = 0;
    let both = 0;
    for (let i = 0; i < 30; i++) {
      const id = await w.reply(asked.message_id, `k${i}`, `Round ${i}: ARM.`);
      await Bun.sleep(Math.random() * 160);
      const taken = await w.takeBack(id);
      if (taken.status === 200) takenBack++;
      else for (let t = 0; t < 75 && !w.server.store.message(id)?.delivery; t++) await Bun.sleep(20);
      await Bun.sleep(taken.status === 200 ? 200 : 0);
      if (taken.status === 200 && delivered.includes(id)) both++;
    }
    expect(both).toBe(0);
    expect(takenBack).toBeGreaterThan(0);
    expect(takenBack).toBeLessThan(30);
  }, 120_000);
});
