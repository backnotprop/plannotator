/**
 * The swarm's plan (`plannotator inbox swarm propose`) and where a member runs. The failures these guard: a proposal
 * that never reaches the thread, or reaches it as a second card when another agent adds to it; a line for a name
 * already in the plan added again instead of replacing it; a bad line written half-way; a proposal from an agent that
 * did not join; a linked computer's agent shown as running on this computer before it joined.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { composeInboxSkillsBlock, inboxBuiltinSkillContent } from "@plannotator/core/inbox-skills-compose";
import { INBOX_MESSAGE_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import type { SkillCatalogEntry } from "@plannotator/core/skill-references-render";
import { SWARM_SKILL } from "@plannotator/core/swarm-skill";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { parseSwarmPlan, startSwarm, swarmWire } from "@plannotator/shared/inbox/swarm";
import { farSwarmAnswer, swarmRoute, type SwarmRouteContext } from "./inbox-swarm-route";

const SWARM_REF = { name: SWARM_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true } as SkillCatalogEntry;
const SWARM_BLOCK = composeInboxSkillsBlock([SWARM_REF], new Map([[SWARM_SKILL.name, inboxBuiltinSkillContent(SWARM_REF, false)!]]), INBOX_MESSAGE_SKILL_AUDIENCE);
/** The linked computer "Laptop". */
const LAPTOP = "ibx_01KAZ00000000000000000000C";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-swarm-plan-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date() });
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const thread = store.startPersonThread({
    project_id: project.id,
    body: `Split the refunds fix between you. /swarm\n\n${SWARM_BLOCK}`,
    idempotency_key: "k1",
    to: { host: "claude-code", session: "ses_claude" },
    tags: [
      { host: "codex", session: "ses_codex", wakes: true },
      { host: "pi", session: "ses_pi", wakes: true, machine: LAPTOP },
    ],
  }).message;
  startSwarm(store, thread.id);
  const ctx: SwarmRouteContext = {
    store,
    on: () => true,
    live: () => null,
    ownSession: (s) => s === "ses_claude" || s === "ses_codex",
    wakes: (s) => s === "ses_claude",
    far: { placeOf: async () => null, nameOf: (m) => (m === LAPTOP ? "Laptop" : null), ask: async () => ({ status: 409, json: null }) },
  };
  return { store, thread: thread.id, ctx };
}

const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
const ask = async (ctx: SwarmRouteContext, body: unknown) => {
  const req = new Request("http://127.0.0.1:1/api/inbox/swarm", { method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:1" }, body: JSON.stringify(body) });
  const res = (await swarmRoute(req, new URL(req.url), ctx, readBody))!;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const CLAUDE = { host: "claude-code", session: "ses_claude", name: "Claude Code" };
const CODEX = { host: "codex", session: "ses_codex", name: "Codex" };
const cards = (store: InboxStore, thread: string) => store.threadMessageIds(thread).map((id) => store.message(id)!).filter((m) => m.swarm_plan === true);

const PROPOSAL = [
  "Three parts, one per agent. The refunds go last: they read the new rounding.",
  "- Claude Code: Rounding in refunds.ts",
  "  - Test writer: Tests for the rounding rules",
  "- **Codex**: Find the refunds that went out short",
  "- Pi: Re-send the short refunds",
].join("\n");

test("the first proposal is the plan card, written once as the agent's reply; another agent's lines change the same plan", async () => {
  const { store, thread, ctx } = world();
  expect((await ask(ctx, { action: "join", thread, by: CLAUDE })).status).toBe(200);
  expect((await ask(ctx, { action: "join", thread, by: CODEX })).status).toBe(200);
  const first = await ask(ctx, { action: "propose", thread, text: PROPOSAL, by: CLAUDE });
  expect(first.status).toBe(200);
  expect(first.json.text).toContain(`the plan is in thread ${thread} as your reply, 4 lines`);

  const [card] = cards(store, thread);
  expect(cards(store, thread)).toHaveLength(1);
  // The agent's reply to the person's message, woken by its own connection, with the plan as plain words for any reader.
  expect({ author: card!.author.kind === "agent" ? card!.author.session : null, reply_to: card!.reply_to, wakes: card!.wakes }).toEqual({ author: "ses_claude", reply_to: thread, wakes: true });
  expect(card!.body).toContain("- Claude Code: Rounding in refunds.ts\n  - Test writer: Tests for the rounding rules");
  const plan = swarmWire(store, thread, () => null)!.plan!;
  expect(plan.message_id).toBe(card!.id);
  expect(plan.summary).toBe("Three parts, one per agent. The refunds go last: they read the new rounding.");
  expect(plan.parts.map((p) => [p.who, p.for ?? null, p.by])).toEqual([
    ["Claude Code", null, "Claude Code"],
    ["Test writer", "Claude Code", "Claude Code"],
    ["Codex", null, "Claude Code"],
    ["Pi", null, "Claude Code"],
  ]);

  // Codex adds its own sub-agent and changes its own line: the same plan, the same card, no second message.
  const before = store.threadMessageIds(thread).length;
  const added = await ask(ctx, { action: "propose", thread, text: "- Codex: List the short refunds in refunds-short.csv\n  - Migration check: The berth_rates migration runs clean", by: CODEX });
  expect(added.status).toBe(200);
  expect(added.json.text).toContain("Added to the plan");
  expect(store.threadMessageIds(thread).length).toBe(before);
  const after = swarmWire(store, thread, () => null)!.plan!;
  expect(after.message_id).toBe(card!.id);
  expect(after.summary).toBe(plan.summary);
  expect(after.parts.map((p) => [p.who, p.does, p.for ?? null, p.by])).toEqual([
    ["Claude Code", "Rounding in refunds.ts", null, "Claude Code"],
    ["Test writer", "Tests for the rounding rules", "Claude Code", "Claude Code"],
    ["Codex", "List the short refunds in refunds-short.csv", null, "Codex"],
    ["Pi", "Re-send the short refunds", null, "Claude Code"],
    ["Migration check", "The berth_rates migration runs clean", "Codex", "Codex"],
  ]);
});

test("a proposal is refused whole: from an agent that has not joined, with a line that names no one, or with nothing", async () => {
  const { store, thread, ctx } = world();
  const outsider = await ask(ctx, { action: "propose", thread, text: PROPOSAL, by: CLAUDE });
  expect([outsider.status, outsider.json.code]).toEqual([409, "not_in_swarm"]);
  await ask(ctx, { action: "join", thread, by: CLAUDE });
  const bad = await ask(ctx, { action: "propose", thread, text: "- Claude Code: Rounding\n- just do the refunds", by: CLAUDE });
  expect([bad.status, bad.json.code]).toEqual([422, "validation_error"]);
  expect(bad.json.error).toContain("Line 2:");
  const empty = await ask(ctx, { action: "propose", thread, text: "  \n ", by: CLAUDE });
  expect(empty.status).toBe(422);
  expect(cards(store, thread)).toHaveLength(0);
  expect(store.swarmOf(thread)!.plan ?? null).toBeNull();
});

test("an indented line with no agent above it in the proposal is the proposer's own sub-agent", () => {
  expect(parseSwarmPlan("  - Test writer: Tests", "Codex").parts).toEqual([{ who: "Test writer", does: "Tests", for: "Codex" }]);
  expect(parseSwarmPlan("1. Pi: Invoices\n2) Codex: Prices", "Codex").parts.map((p) => p.who)).toEqual(["Pi", "Codex"]);
});

test("an agent on a linked computer that has not joined says its own computer, never this one's", async () => {
  const { store, thread, ctx } = world();
  const wire = swarmWire(store, thread, () => null, ctx.far!.nameOf)!;
  expect(wire.members.find((m) => m.session === "ses_pi")).toMatchObject({ joined: false, machine_name: "Laptop" });
  // This computer's own agent that has not joined names no other computer.
  expect(wire.members.find((m) => m.session === "ses_codex")!.machine_name).toBeUndefined();
  const status = await ask(ctx, { action: "join", thread, by: CLAUDE });
  expect(status.json.text).toContain("- Pi, on Laptop, not joined yet");
});

test("an agent on a linked computer proposes through its door: the card is its reply, from that computer", () => {
  const { store, thread, ctx } = world();
  farSwarmAnswer(ctx, LAPTOP, { ask: { action: "join", thread }, session: "ses_pi", host: "pi", name: null });
  farSwarmAnswer(ctx, LAPTOP, { ask: { action: "propose", thread, text: "- Pi: Re-send the short refunds" }, session: "ses_pi", host: "pi", name: null });
  const [card] = cards(store, thread);
  expect(card!.author).toMatchObject({ kind: "agent", session: "ses_pi", machine: LAPTOP, machine_name: "Laptop" });
  // Its connection is that computer's: this one does not say it wakes.
  expect(card!.wakes).toBeUndefined();
});
