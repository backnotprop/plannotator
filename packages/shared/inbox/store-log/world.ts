/** Test-only: a realistic Inbox written through the store's own write paths from a seeded random walk. A refused step is skipped. */
import type { InboxAttachment, InboxAuthor, InboxProject, InboxQuestion } from "@plannotator/core/inbox-types";
import { parseInboxThreadPullRefs } from "@plannotator/core/inbox-types";
import { InboxError } from "../schema";
import { InboxStore } from "../store";
import type { InboxLogFactory } from "./log";

type Agent = Extract<InboxAuthor, { kind: "agent" }> & { session: string };

const AGENTS: Agent[] = [
  { kind: "agent", host: "claude-code", session: "ses_world_a", name: "Claude Code" },
  { kind: "agent", host: "codex", session: "ses_world_b", name: null },
  { kind: "agent", host: "pi", session: "ses_world_c", name: "Pi" },
];
const WORDS = "deploy retry billing worker flag schema cache review merge release webhook invoice queue migration bookmark search".split(" ");
const TAGS = ["#Billing", "#Search", "#Release"];

function pullRefs(value: string) {
  const parsed = parseInboxThreadPullRefs([value], "add");
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.refs;
}

const addressOf = (agent: Agent) => ({ host: agent.host ?? "claude-code", session: agent.session });

/** mulberry32: seeded, so a failing seed can be run again. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface InboxWorld {
  store: InboxStore;
  now: () => Date;
  projects: InboxProject[];
  agents: Agent[];
}

export interface InboxWorldOptions {
  dataDir: string;
  seed: number;
  steps: number;
  messages?: number;
  log?: InboxLogFactory;
  growOnly?: boolean;
}

export function writeInboxWorld(options: InboxWorldOptions): InboxWorld {
  const random = seeded(options.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const chance = (p: number) => random() < p;
  let clock = Date.parse("2026-10-01T09:00:00.000Z");
  const now = () => new Date(clock);
  const store = InboxStore.open(options.dataDir, { now, log: options.log });
  const projects = ["web", "api", "billing"].map((name) => store.ensureProject({ name, root: `/work/${name}` }));
  const roots: string[] = [];
  const personRoots: { id: string; to: Agent }[] = [];
  const agentMessages: string[] = [];
  let n = 0;

  const words = (count: number) => Array.from({ length: count }, () => pick(WORDS)).join(" ");
  const questionBlock = (i: number) => [":::question", `Ship the ${pick(WORDS)} change (${i})?`, "", "- [ ] Yes", "- [ ] No", "- [ ] Later", ":::"].join("\n");
  const actionBlock = () => [":::action", `Approve the ${pick(WORDS)} job`, "Stopped: the release", ":::"].join("\n");
  const attachment = (): InboxAttachment => {
    const id = `att_${String(++n).padStart(26, "0")}`;
    return { id, path: `/work/notes/${id}.md`, named_path: null, name: `${id}.md`, kind: "markdown", sent_sha256: "0".repeat(64), size: 10, sent_at: "", sent_mtime: "2026-10-01T00:00:00.000Z" };
  };
  const answerFor = (q: InboxQuestion, label: string) => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] });
  const openQuestions = (messageId: string) => store.questionsOf(messageId).filter((q) => q.state === "open" || q.state === "picked");

  const agentSends = () => {
    const author = pick(AGENTS);
    const project = pick(projects);
    const reply = roots.length > 0 && chance(0.5);
    const parts = [`## ${words(3)}`, "", `${words(12)} ${chance(0.3) ? pick(TAGS) : ""}`];
    if (chance(0.5)) parts.push("", questionBlock(n++));
    if (chance(0.2)) parts.push("", questionBlock(n++));
    if (chance(0.15)) parts.push("", actionBlock());
    const sent = store.sendMessage({
      project_id: project.id,
      author,
      body: parts.join("\n"),
      subject: reply ? null : `${words(2)} ${n}`,
      reply_to: reply ? pick(roots) : null,
      thread: !reply && chance(0.3) ? `lane-${Math.floor(random() * 6)}` : null,
      idempotency_key: chance(0.1) ? `k-${Math.floor(random() * 40)}` : null,
      attachments: chance(0.1) ? [attachment()] : undefined,
      wakes: chance(0.3),
    });
    if (!roots.includes(sent.message.thread_id)) roots.push(sent.message.thread_id);
    agentMessages.push(sent.message.id);
  };

  const personPicks = () => {
    const id = pick(agentMessages);
    const qs = openQuestions(id);
    if (qs.length === 0) return;
    store.savePicks(
      id,
      qs.filter((q) => q.kind !== "action").map((q) => ({ key: q.key, revision: q.revision, answer: answerFor(q, pick(["Yes", "No", "Later"])) })),
    );
    picked.add(id);
  };

  const personTypes = () => {
    const id = pick(agentMessages);
    const q = openQuestions(id).find((x) => x.kind !== "action");
    if (!q) return;
    const label = pick(["Yes", "No", "Later"]);
    const note = words(3);
    let revision = q.revision;
    for (let end = 2; end <= note.length; end += 1 + Math.floor(random() * 4)) {
      const [saved] = store.savePicks(id, [{ key: q.key, revision, answer: { ...answerFor(q, label), note: note.slice(0, end) } }]);
      if (!saved) return;
      revision = saved.revision;
    }
    picked.add(id);
  };

  const personStarts = () => {
    const to = pick(AGENTS);
    // Sometimes named: typed (holds the name), or compose's suggestion (an agent may still replace it).
    const named = chance(0.4) ? { thread_name: `mine-${n}`, thread_name_auto: chance(0.5) } : {};
    const started = store.startPersonThread({ project_id: pick(projects).id, body: words(8), to: addressOf(to), idempotency_key: `p-${n++}`, ...named });
    if (!roots.includes(started.message.thread_id)) roots.push(started.message.thread_id);
    personRoots.push({ id: started.message.id, to });
  };

  const agentNames = () => {
    const thread = personRoots.length > 0 ? pick(personRoots) : null;
    if (!thread || !store.message(thread.id)) return;
    const sent = store.sendMessage({ project_id: store.message(thread.id)!.project_id, author: thread.to, body: words(6), reply_to: thread.id, thread: `named-${n++}` });
    agentMessages.push(sent.message.id);
  };

  const personReaddresses = () => {
    const thread = personRoots.length > 0 ? pick(personRoots) : null;
    if (!thread || !store.message(thread.id)) return;
    const other = AGENTS.find((agent) => agent.session !== thread.to.session && chance(0.5)) ?? AGENTS.find((agent) => agent.session !== thread.to.session)!;
    store.readdressMessage(thread.id, addressOf(other), { askerEnded: true });
    thread.to = other;
  };

  const agentReplaces = () => {
    const id = pick(agentMessages);
    const q = openQuestions(id).find((x) => x.kind !== "action");
    const message = store.message(id);
    if (!q || !message || message.author.kind !== "agent") return;
    const sent = store.sendMessage({ project_id: message.project_id, author: message.author, body: `${words(5)}\n\n${questionBlock(n++)}`, reply_to: id, supersedes: [`${id}/${q.key}`] });
    agentMessages.push(sent.message.id);
  };

  const personActs = () => {
    const id = pick(agentMessages);
    const action = store.questionsOf(id).find((q) => q.kind === "action" && q.state === "open");
    if (action) store.markAction(id, action.key, { outcome: pick(["done", "cant"]), note: words(3) });
  };

  const picked = new Set<string>();
  const personSends = () => {
    const id = picked.size > 0 && chance(0.8) ? pick([...picked]) : pick(agentMessages);
    picked.delete(id);
    const qs = store.questionsOf(id).filter((q) => q.state === "picked");
    store.sendReply(id, { words: chance(0.7) ? words(6) : undefined, questions: qs.map((q) => ({ key: q.key, revision: q.revision })), idempotency_key: `r-${n++}` });
  };

  const ops: [weight: number, run: () => void][] = [
    [30, agentSends],
    [14, personPicks],
    [4, personTypes],
    [10, personSends],
    [3, agentReplaces],
    [2, personActs],
    [3, () => store.sendReask(pick(agentMessages), { idempotency_key: `q-${n++}` })],
    [6, () => store.markSeen(pick(roots))],
    [4, () => store.markRead(pick(roots), chance(0.7))],
    [3, () => store.resolveThread(pick(roots), chance(0.8), chance(0.5) ? "person" : "agent")],
    [3, () => store.saveMessageAnnotation(pick(agentMessages), { id: `c-${n++}`, type: "COMMENT", originalText: "the", text: words(4) })],
    [2, () => store.ackMessage(pick(agentMessages), true)],
    [3, personStarts],
    [2, agentNames],
    [1, personReaddresses],
    [2, () => store.markAgentChecked(pick(roots), Number.POSITIVE_INFINITY, now().toISOString(), pick(AGENTS).session)],
    [3, () => store.setThreadSteps({ thread_id: pick(roots), agent: pick(AGENTS), steps: [{ step: words(3), status: "done" }, { step: words(3), status: pick(["doing", "waiting"]) }] })],
    [2, () => store.changeThreadPulls({ thread_id: pick(roots), add: pullRefs(`o/r#${1 + Math.floor(random() * 5)}`), by: pick(AGENTS) })],
    [1, () => store.changeThreadPulls({ thread_id: pick(roots), remove: "all", by: { kind: "person" } })],
    [2, () => store.createCard({ project_id: pick(projects).id, by: chance(0.5) ? pick(AGENTS) : { kind: "person" }, title: words(3), threads: [], initiative_name: chance(0.3) ? pick(["Billing", "Search"]) : undefined })],
    [2, () => {
      const card = store.listCards()[0];
      if (card) store.updateCard(card.id, { by: { kind: "person" }, column: pick(["backlog", "todo", "in_progress", "done"]) });
    }],
    [2, () => {
      // The seen mark is a seen-only line, not a change to the card.
      const card = pick(store.listCards().length > 0 ? store.listCards() : [null]);
      if (card) store.updateCard(card.id, { by: pick(AGENTS), column: "dropped", reason: words(2) });
    }],
    [2, () => store.markCardDropsSeen()],
    [1, () => store.setPinned(pick(roots), chance(0.7))],
    [1, () => store.setSnooze(pick(roots), new Date(clock + 3 * 3600_000).toISOString())],
    [2, () => store.saveReplyDraft(pick(roots), { body: words(5), base: null })],
    [1, () => store.renameProject(pick(projects).id, chance(0.7) ? `${pick(WORDS)} app` : null)],
  ];
  if (!options.growOnly) {
    ops.push([1, () => store.combineProject(projects[2]!.id, chance(0.6) ? projects[1]!.id : null)]);
    ops.push([1, () => {
      const id = roots.splice(Math.floor(random() * roots.length), 1)[0];
      if (!id) return;
      store.deleteThread(id);
      for (let i = agentMessages.length - 1; i >= 0; i--) if (!store.message(agentMessages[i]!)) agentMessages.splice(i, 1);
    }]);
  }
  const total = ops.reduce((sum, [w]) => sum + w, 0);

  const seen = new Set<string>();
  store.subscribe((line) => {
    if (line.kind === "message") seen.add(line.id);
  });
  for (let step = 0; step < options.steps && seen.size < (options.messages ?? Number.POSITIVE_INFINITY); step++) {
    clock += 1000 + Math.floor(random() * 120_000);
    let roll = random() * total;
    const op = ops.find(([w]) => (roll -= w) < 0)![1];
    if (roots.length === 0 || agentMessages.length === 0) {
      agentSends();
      continue;
    }
    try {
      op();
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
    }
  }
  clock += 60_000;
  return { store, now, projects, agents: AGENTS };
}
