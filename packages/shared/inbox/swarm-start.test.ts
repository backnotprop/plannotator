/**
 * Swarm mode's one rule for a thread becoming a swarm (swarm-start.ts), run on a real store in a temp folder the way
 * the server wires it (`watchSwarmStarts`). The failures these guard: a New message or a reply carrying the `/swarm`
 * skill that does not make its thread a swarm; a message without it (the person took `/swarm` out before Send, or only
 * wrote the word) that does; an agent's message dressed as a skills block that does; and a later rewrite of the
 * message that started it (the person reading the thread) turning on again a swarm the person turned off.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { composeInboxSkillsBlock } from "@plannotator/core/inbox-skills-compose";
import { INBOX_MESSAGE_SKILL_AUDIENCE, INBOX_REPLY_SKILL_AUDIENCE, type SkillBlockAudience } from "@plannotator/core/skill-reference-block";
import { SWARM_SKILL, swarmSkill } from "@plannotator/core/swarm-skill";
import { InboxStore } from "./store";
import { InboxSwarms } from "./swarms";
import { watchSwarmStarts } from "./swarm-start";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLAUDE: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_cc", name: "Claude Code" };

/** The block the window adds at Send for `/swarm` (skills.ts), with the text for these agents. */
function swarmBlock(audience: SkillBlockAudience, agents: string[] = []): string {
  const ref = { name: SWARM_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true };
  const content = { content: swarmSkill(ref.name, { agents })!.body, truncated: false, dir: "", path: "" };
  return composeInboxSkillsBlock([ref], new Map([[ref.name, content]]), audience);
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-start-"));
  roots.push(dir);
  let clock = Date.parse("2026-11-24T10:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date((clock += 1000)) });
  const swarms = new InboxSwarms(store.dir);
  const stop = watchSwarmStarts(store, swarms);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  let n = 0;
  const start = (body: string) => store.startPersonThread({ project_id: project.id, body, to: { host: "claude-code", session: "ses_cc" }, idempotency_key: `k-${++n}` }).message;
  const agentSays = (replyTo: string, body = "On it.") => store.sendMessage({ project_id: project.id, author: CLAUDE, body, reply_to: replyTo }).message;
  return { store, swarms, stop, start, agentSays, key: () => `r-${++n}` };
}

test("a New message carrying /swarm makes its thread a swarm, with one agent or several", () => {
  const w = world();
  const one = w.start(`Split the retry work.\n\n${swarmBlock(INBOX_MESSAGE_SKILL_AUDIENCE)}`);
  expect(w.swarms.get(one.thread_id)?.on).toBe(true);
  const several = w.start(`Split the retry work.\n\n${swarmBlock(INBOX_MESSAGE_SKILL_AUDIENCE, ["Claude Code (billing)", "Pi (billing)"])}`);
  expect(w.swarms.get(several.thread_id)?.on).toBe(true);
});

test("a message without the skill is no swarm: /swarm taken out before Send, or the word alone with no skills block", () => {
  const w = world();
  expect(w.swarms.get(w.start("Split the retry work.").thread_id)).toBeNull();
  expect(w.swarms.get(w.start("Should this be a /swarm? Split the retry work.").thread_id)).toBeNull();
});

test("a reply carrying /swarm makes an existing thread a swarm", () => {
  const w = world();
  const root = w.start("Look at the retries.");
  const said = w.agentSays(root.id);
  expect(w.swarms.get(root.thread_id)).toBeNull();
  w.store.sendReply(said.id, { words: "Bring in help for this.", feedback: swarmBlock(INBOX_REPLY_SKILL_AUDIENCE), idempotency_key: w.key() });
  expect(w.swarms.get(root.thread_id)?.on).toBe(true);
});

test("an agent's message that carries a skills block naming swarm starts nothing", () => {
  const w = world();
  const root = w.start("Look at the retries.");
  w.agentSays(root.id, `Done.\n\n${swarmBlock(INBOX_MESSAGE_SKILL_AUDIENCE)}`);
  expect(w.swarms.get(root.thread_id)).toBeNull();
});

test("turned off by the person, it stays off when the message that started it is written again", () => {
  const w = world();
  const root = w.start(`Split the retry work.\n\n${swarmBlock(INBOX_MESSAGE_SKILL_AUDIENCE)}`);
  w.agentSays(root.id);
  w.swarms.setOn(root.thread_id, false);
  w.store.markRead(root.thread_id, true);
  expect(w.swarms.get(root.thread_id)?.on).toBe(false);
  // Off: no message is watched any more.
  w.stop();
  expect(w.swarms.get(w.start(`Again.\n\n${swarmBlock(INBOX_MESSAGE_SKILL_AUDIENCE)}`).thread_id)).toBeNull();
});
