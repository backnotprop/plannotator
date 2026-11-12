import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_LIVE_COLUMNS,
  INBOX_HOST_NAMES,
  INBOX_TIDY_CARD_IDLE_MS,
  INBOX_TIDY_COOLDOWN_MS,
  INBOX_TIDY_HOW,
  INBOX_TIDY_INSTRUCTION,
  INBOX_TIDY_OPEN_ITEM_MS,
  INBOX_TIDY_PERSON_LAST_MS,
  INBOX_TIDY_RUN_SHOWN_MS,
  inboxAgentName,
  inboxSessionRef,
  inboxStepsProgress,
  inboxTidySessionLine,
  isInboxNote,
  type InboxCard,
  type InboxCardColumn,
  type InboxMessage,
  type InboxSteps,
  type InboxTidyAgent,
  type InboxTidyItem,
  type InboxTidyReach,
  type InboxTidyRun,
  type InboxTidyRunAgent,
} from "@plannotator/core/inbox-types";
import { inboxSearchReplyText } from "./search";
import type { InboxStore } from "./store";

const TIDY_CARD_COLUMNS: ReadonlySet<InboxCardColumn> = new Set(["todo", "in_progress"]);

export type InboxTidySurface = "list" | "board";

export interface InboxTidyOptions {
  projectId: string | null;
  surface: InboxTidySurface;
  now: number;
  reachOf: (session: string) => InboxTidyReach | null;
  boardOn: boolean;
  stepsStale?: ((record: InboxSteps) => boolean) | null;
}

interface PlanItem extends InboxTidyItem {
  reply_to: string | null;
  lines: string[];
  cards: string[];
}

export interface InboxTidyPlanAgent extends Omit<InboxTidyAgent, "items"> {
  items: PlanItem[];
}

export interface InboxTidyPlanResult {
  agents: InboxTidyPlanAgent[];
}

export function inboxTidyAge(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

function shortAge(ms: number): string {
  const age = inboxTidyAge(ms);
  return age.endsWith(" days") ? `${age.slice(0, -5)} d` : age;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const hostName = (host: string | null | undefined): string => (host ? (INBOX_HOST_NAMES[host] ?? host) : "An agent");

export function inboxTidyPlan(store: InboxStore, options: InboxTidyOptions): InboxTidyPlanResult {
  const { now, projectId } = options;
  const agents = new Map<string, InboxTidyPlanAgent>();
  const projectName = (id: string) => store.project(id)?.name ?? "";

  const itemOf = (session: string, host: string | null, name: string, reach: InboxTidyReach, key: string, make: () => PlanItem): PlanItem => {
    let agent = agents.get(session);
    if (!agent) {
      agent = { session, host, name, reach, items: [] };
      agents.set(session, agent);
    }
    let item = agent.items.find((i) => (i.thread_id ?? i.subject) === key);
    if (!item) {
      item = make();
      agent.items.push(item);
    }
    return item;
  };

  const projectIds = projectId ? new Set([projectId]) : null;
  const cards = options.boardOn ? store.listCards({ projectIds }) : [];
  const boardSessions = new Set<string>();
  const boardThreads = new Set<string>();
  if (options.surface === "board") {
    for (const card of cards) {
      if (card.agent?.kind !== "agent" || !card.agent.session) continue;
      if (!INBOX_CARD_LIVE_COLUMNS.includes(card.column)) continue;
      boardSessions.add(card.agent.session);
      for (const id of card.threads) boardThreads.add(id);
    }
  }
  const inScope = (session: string | null) => options.surface === "list" || (session !== null && boardSessions.has(session));

  const threadItem = (session: string, host: string | null, name: string, reach: InboxTidyReach, threadId: string, messages: readonly InboxMessage[]) =>
    itemOf(session, host, name, reach, threadId, () => {
      const root = store.message(threadId)!;
      const last = [...messages].reverse().find((m) => !isInboxNote(m)) ?? root;
      return {
        thread_id: threadId,
        subject: store.threadSubject(threadId) ?? "(no subject)",
        project: { id: store.canonicalProjectId(root.project_id), name: projectName(root.project_id) },
        reasons: [],
        reply_to: last.id,
        lines: [],
        cards: [],
      };
    });

  const signal = (who: { session: string | null; host: string | null; name: string }, threadId: string, messages: readonly InboxMessage[], reason: string, lines: string[]) => {
    if (!inScope(who.session)) return;
    const reach = who.session ? options.reachOf(who.session) : null;
    if (!who.session || !reach) return;
    const item = threadItem(who.session, who.host, who.name, reach, threadId, messages);
    item.reasons.push(reason);
    item.lines.push(...lines);
  };

  for (const threadId of store.threadIds()) {
    const root = store.message(threadId);
    if (!root || root.resolved_at !== null) continue;
    if (projectId && !store.sameProject(root.project_id, projectId)) continue;
    if (options.surface === "board" && !boardThreads.has(threadId)) continue;
    const messages = store.threadMessageIds(threadId).map((id) => store.message(id)!).filter(Boolean);
    const reasked = store.reaskListedIds(threadId);

    const real = messages.filter((m) => !isInboxNote(m));
    const last = real[real.length - 1];
    if (last && last.author.kind === "person" && now - Date.parse(last.created_at) >= INBOX_TIDY_PERSON_LAST_MS) {
      const to = store.recipientOf(last);
      if (to) {
        const checked = (root.agent_checked_seq ?? 0) >= (store.messageCursor(last.id) ?? Number.MAX_SAFE_INTEGER);
        const reach = options.reachOf(to.session);
        if (last.delivery || checked || reach !== "wakes") {
          const words = oneLine(inboxSearchReplyText(last.body, last) || last.body, 120);
          signal({ session: to.session, host: to.host, name: hostName(to.host) }, threadId, messages, "you wrote last", [
            `The person wrote last, ${inboxTidyAge(now - Date.parse(last.created_at))} ago: "${words}"`,
          ]);
        }
      }
    }

    const bySession = new Map<string, { who: { session: string | null; host: string | null; name: string }; questions: string[]; actions: string[]; qAge: number; aAge: number }>();
    for (const message of messages) {
      if (message.author.kind !== "agent") continue;
      for (const q of store.questionsOf(message.id)) {
        if (q.state !== "open" || q.orphaned || reasked.has(`${message.id}/${q.key}`)) continue;
        const age = now - Date.parse(message.created_at);
        if (age < INBOX_TIDY_OPEN_ITEM_MS) continue;
        const key = message.author.session ?? `none:${message.id}`;
        const entry =
          bySession.get(key) ??
          bySession.set(key, { who: { session: message.author.session, host: message.author.host, name: inboxAgentName(message.author) }, questions: [], actions: [], qAge: 0, aAge: 0 }).get(key)!;
        const line = `${message.id}/${q.key}  ${oneLine(q.prompt, 120)}`;
        if (q.kind === "action") {
          entry.actions.push(line);
          entry.aAge = Math.max(entry.aAge, age);
        } else {
          entry.questions.push(line);
          entry.qAge = Math.max(entry.qAge, age);
        }
      }
    }
    for (const { who, questions, actions, qAge, aAge } of bySession.values()) {
      if (questions.length > 0) {
        const n = questions.length;
        signal(who, threadId, messages, `${n === 1 ? "question" : `${n} questions`}, ${shortAge(qAge)}`, [
          `${n} open question${n === 1 ? "" : "s"}, asked ${inboxTidyAge(qAge)} ago:`,
          ...questions.map((line) => `  ${line}`),
        ]);
      }
      for (const line of actions) signal(who, threadId, messages, `action item, ${shortAge(aAge)}`, [`Action item open since ${inboxTidyAge(aAge)} ago: ${line}`]);
    }

    if (options.stepsStale) {
      for (const record of store.threadSteps(threadId)) {
        if (!record.agent.session || !options.stepsStale(record)) continue;
        const { done, total, doing } = inboxStepsProgress(record.steps);
        if (doing === null) continue;
        const age = Math.max(0, now - Date.parse(record.updated_at));
        signal({ session: record.agent.session, host: record.agent.host, name: inboxAgentName(record.agent) }, threadId, messages, `step in progress, ${shortAge(age)}`, [
          `${TIDY_STEPS_LEAD}${done} of ${total} done; doing: ${oneLine(doing, 80)}, unchanged for ${inboxTidyAge(age)}. Update them if that changed (the steps action, thread_id ${threadId}).`,
        ]);
      }
    }
  }

  for (const card of cards) {
    if (!TIDY_CARD_COLUMNS.has(card.column) || card.agent?.kind !== "agent" || !card.agent.session) continue;
    const idle = now - Date.parse(card.moved_at);
    if (idle < INBOX_TIDY_CARD_IDLE_MS) continue;
    const session = card.agent.session;
    if (!inScope(session)) continue;
    const reach = options.reachOf(session);
    if (!reach) continue;
    const name = inboxAgentName(card.agent);
    const line = cardLine(card, idle);
    const reason = `card idle ${shortAge(idle)}`;
    const agent = agents.get(session);
    const linked = card.threads.find((id) => agent?.items.some((i) => i.thread_id === id)) ?? card.threads.find((id) => openThreadInScope(store, id, projectId));
    if (linked) {
      const messages = store.threadMessageIds(linked).map((id) => store.message(id)!).filter(Boolean);
      const item = threadItem(session, card.agent.host, name, reach, linked, messages);
      item.reasons.push(reason);
      item.lines.push(line);
      item.cards.push(card.id);
    } else {
      const item = itemOf(session, card.agent.host, name, reach, `card:${card.id}`, () => ({
        thread_id: null,
        subject: card.title,
        project: { id: store.canonicalProjectId(card.project_id), name: projectName(card.project_id) },
        reasons: [],
        reply_to: null,
        lines: [],
        cards: [],
      }));
      item.reasons.push(reason);
      item.lines.push(line);
      item.cards.push(card.id);
    }
  }

  for (const session of [...agents.keys()]) if (cooling(store, session, now)) agents.delete(session);

  return {
    agents: [...agents.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name)),
  };
}

function openThreadInScope(store: InboxStore, threadId: string, projectId: string | null): boolean {
  const root = store.message(threadId);
  return !!root && root.thread_id === threadId && root.resolved_at === null && (!projectId || store.sameProject(root.project_id, projectId));
}

function cardLine(card: InboxCard, idle: number): string {
  const said = card.said ? ` Your last word on it: "${oneLine(card.said, 120)}".` : "";
  return `Board card "${oneLine(card.title, 80)}" (${card.id}) is in ${INBOX_CARD_COLUMN_LABELS[card.column]} and hasn't moved in ${inboxTidyAge(idle)}.${said}`;
}

function cooling(store: InboxStore, session: string, now: number): boolean {
  const last = store
    .tidyNotes()
    .filter((m) => m.tidy?.wake && m.to?.session === session)
    .pop();
  if (!last) return false;
  if (!last.delivery) return true;
  if (last.delivery.host === INBOX_TIDY_WITHDRAWN_HOST) return false;
  if (now - Date.parse(last.created_at) >= INBOX_TIDY_COOLDOWN_MS) return false;
  const after = store.messageCursor(last.id) ?? 0;
  for (const threadId of store.threadIds()) {
    for (const id of store.threadMessageIds(threadId)) {
      const m = store.message(id);
      if (!m || m.author.kind !== "person" || isInboxNote(m) || (store.messageCursor(id) ?? 0) <= after) continue;
      if (store.recipientOf(m)?.session === session) return false;
    }
  }
  return true;
}

const TIDY_STEPS_LEAD = "Your steps here: ";
const TIDY_STEPS_BODY_LINE = `   - ${TIDY_STEPS_LEAD}`;

export function inboxTidyBodyStepsOff(body: string): string {
  if (!body.includes(`\n${TIDY_STEPS_BODY_LINE}`)) return body;
  let n = 0;
  return body
    .split("\n\n")
    .flatMap((part) => {
      if (!/^\d+\. /.test(part)) return [part];
      const lines = part.split("\n").filter((line) => !line.startsWith(TIDY_STEPS_BODY_LINE));
      if (lines.length < 2) return [];
      n += 1;
      return [[lines[0]!.replace(/^\d+\. /, `${n}. `), ...lines.slice(1)].join("\n")];
    })
    .join("\n\n");
}

export function inboxTidyBodyListsAny(body: string): boolean {
  return body.split("\n\n").some((part) => /^\d+\. /.test(part));
}

export const INBOX_TIDY_WITHDRAWN_HOST = "plannotator-inbox";

export function inboxTidyIsStepsOnly(body: string): boolean {
  return body.includes(`\n${TIDY_STEPS_BODY_LINE}`) && !inboxTidyBodyListsAny(inboxTidyBodyStepsOff(body));
}

export function inboxTidyStepsOnlyWakes(store: InboxStore): InboxMessage[] {
  return store.tidyNotes().filter((note) => note.tidy?.wake && note.to && !note.delivery && inboxTidyIsStepsOnly(note.body));
}

export function inboxTidyBody(agent: InboxTidyPlanAgent): string {
  const items = agent.items.map((item, i) => {
    const head =
      item.thread_id !== null
        ? `${i + 1}. ${oneLine(item.subject, 100)} · ${item.project.name} (reply_to ${item.reply_to})`
        : `${i + 1}. ${oneLine(item.subject, 100)} · ${item.project.name}`;
    return [head, ...item.lines.map((line) => `   ${line.startsWith("  ") ? `  ${line.trim()}` : `- ${line}`}`)].join("\n");
  });
  const ref = inboxSessionRef(agent.host, agent.session);
  return [INBOX_TIDY_INSTRUCTION, ref ? `${INBOX_TIDY_HOW} ${inboxTidySessionLine(ref)}` : INBOX_TIDY_HOW, ...items].join("\n\n");
}

export function inboxTidyWakeThread(store: InboxStore, agent: InboxTidyPlanAgent): string | null {
  const listed = agent.items.find((i) => i.thread_id !== null)?.thread_id;
  if (listed) return listed;
  for (const card of agent.items.flatMap((i) => i.cards)) {
    const linked = store.card(card)?.threads.find((id) => store.message(id)?.thread_id === id);
    if (linked) return linked;
  }
  const latest = store.latestAgentMessages().get(agent.session);
  return latest?.thread_id ?? null;
}

export function inboxTidyRun(
  store: InboxStore,
  options: { now: number; idleSince: (session: string) => number | null; reachOf: (session: string) => InboxTidyReach | null },
): InboxTidyRun | null {
  const notes = store.tidyNotes();
  const lastNote = notes[notes.length - 1];
  if (!lastNote?.tidy || options.now - Date.parse(lastNote.created_at) > INBOX_TIDY_RUN_SHOWN_MS) return null;
  const runId = lastNote.tidy.id;
  const wakes = notes.filter((m) => m.tidy?.id === runId && m.tidy.wake && m.to);
  const sessions = new Map(wakes.map((m) => [m.to!.session, m]));
  const listed = new Map<string, Set<string>>();
  for (const m of notes) {
    if (m.tidy?.id !== runId || !m.to) continue;
    (listed.get(m.to.session) ?? listed.set(m.to.session, new Set()).get(m.to.session)!).add(m.thread_id);
  }
  const wrote = new Map<string, Set<string>>();
  for (const threadId of store.threadIds()) {
    for (const id of store.threadMessageIds(threadId)) {
      const m = store.message(id);
      if (!m || m.author.kind !== "agent" || !m.author.session) continue;
      const at = sessions.get(m.author.session)?.delivery?.at;
      if (!at || m.created_at <= at) continue;
      (wrote.get(m.author.session) ?? wrote.set(m.author.session, new Set()).get(m.author.session)!).add(threadId);
    }
  }
  const agents: InboxTidyRunAgent[] = wakes.map((note) => {
    const session = note.to!.session;
    const at = note.delivery?.at ?? null;
    const threads = [...(wrote.get(session) ?? [])].filter((id) => listed.get(session)?.has(id)).length;
    const wroteAny = (wrote.get(session)?.size ?? 0) > 0;
    const cardWrite = at !== null && store.listCards({ agentSession: session }).some((c) => c.heard_by.kind === "agent" && c.heard_by.session === session && c.heard_at > at);
    const idle = options.idleSince(session);
    const reach = options.reachOf(session);
    const state: InboxTidyRunAgent["state"] =
      at === null
        ? reach === null
          ? "ended"
          : "waiting"
        :
          note.delivery?.host === INBOX_TIDY_WITHDRAWN_HOST
          ? "nothing"
          : wroteAny || cardWrite
          ? "tidied"
          : idle !== null && idle > Date.parse(at)
            ? "nothing"
            :
              reach === null
              ? "ended"
              : "delivered";
    return { session, host: note.to!.host, name: hostName(note.to!.host), reach: reach ?? "wakes", state, updated: threads };
  });
  return {
    id: runId,
    at: wakes[0]?.created_at ?? lastNote.created_at,
    agents,
    done: agents.filter((a) => a.state === "tidied" || a.state === "nothing" || a.state === "ended").length,
    updated: agents.reduce((n, a) => n + a.updated, 0),
  };
}
