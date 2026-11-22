/**
 * Combine (approval "inbox-multi-select", 4A "One agent writes a new thread"): the person picks two or more threads
 * and an agent; the agent reads them and starts one new thread that says where everything stands, asking again each
 * open question or saying in one line why it no longer applies. Once that thread arrives, the Inbox archives the
 * picked ones; until then they and their questions stay as they were. An agent that ends or stops without writing it
 * archives nothing.
 *
 * The wake is a Tidy note whose run is the Combine's id (`cmb_`), so it travels as a Tidy's does. Browser-safe and
 * dependency-free but for its sibling `inbox-tidy`; re-exported by `inbox-types`.
 */

import { inboxQuotedWords } from "./inbox-tidy";

/** Where a Combine stands. `asked`: waiting for the new thread; `done`: it arrived and the picked threads are archived. */
export type InboxCombineState = "asked" | "done" | "failed" | "stopped" | "undone";

/** Why a Combine failed: the session ended, its turn ended without the thread, or it never came. */
export type InboxCombineFailure = "ended" | "nothing" | "timeout";

export interface InboxCombineRecord {
  id: string;
  /** The picked threads, in the order the person saw them; `archived`: archived before the Combine, so Undo leaves it there. */
  threads: { id: string; subject: string; archived?: true }[];
  session: string;
  host: string | null;
  /** How the person sees the agent ("Claude Code", or its session's title). */
  name: string;
  /** The person's own words for it, when they gave any. */
  words?: string;
  at: string;
  state: InboxCombineState;
  reason?: InboxCombineFailure;
  /** The new thread, once it arrived. */
  thread?: { id: string; subject: string };
  settled_at?: string;
  /**
   * Picks on two computers (approval "inbox-combine-across-computers"): the linked machines (`ibx_` ids) where this
   * Combine's archive (done) or its Undo (undone) still waits to land, that machine asleep. Absent when none.
   */
  waiting_on?: string[];
}

/**
 * One agent the person can ask to combine picked threads: a running session that wrote in at least one of them (with
 * picks on two computers, `all=1`, any running session, `threads` 0 for one that wrote in none).
 */
export interface InboxCombineAgent {
  session: string;
  host: string | null;
  name: string;
  /** Its session's title, when the window knows one (the sidebar's Agents name). */
  title?: string;
  /** The subject of the picked thread it wrote in last: its name where it has no title, as the sidebar's Agents name it. */
  thread?: string;
  /** The project of the picked thread it wrote in last. */
  project?: string;
  /** When it last wrote in a picked thread: what first tells apart two agents that read the same (`inboxCombineAgentApart`). */
  wrote_at?: string;
  /** How many of the picked threads it wrote in. */
  threads: number;
}

/**
 * How the dialog and the toasts name an agent: its host, then its session's title or its project ("Claude Code ·
 * billing-svc"); the thread it wrote in last instead where two of the agents would read the same.
 */
export function inboxCombineAgentLabel(agent: InboxCombineAgent, all: readonly InboxCombineAgent[] = [agent]): string {
  const of = (a: InboxCombineAgent) => a.title ?? a.project ?? a.thread;
  const part = of(agent);
  if (!part) return agent.name;
  const twin = all.some((a) => a.session !== agent.session && a.name === agent.name && of(a) === part);
  return `${agent.name} · ${twin && !agent.title && agent.thread ? agent.thread : part}`;
}

/**
 * What the line under an agent's name adds to tell it from the others whose name reads the same: when it last wrote
 * (`when` formats it), then its project, then the end of its session id ("session 3f9a"), each only while another of
 * them still matches everything before it. None for an agent whose name no other has. Two such agents never get the
 * same parts: at the first of these where they differ, both say it. There is no machine step: the dialog ends each
 * line with the agent's computer whenever a linked one is involved (picks on two computers list both computers' agents).
 */
export function inboxCombineAgentApart(agent: InboxCombineAgent, all: readonly InboxCombineAgent[], when: (iso: string) => string): string[] {
  const label = inboxCombineAgentLabel(agent, all);
  const same = all.filter((a) => inboxCombineAgentLabel(a, all) === label);
  const steps: ((a: InboxCombineAgent) => string | undefined)[] = [
    (a) => (a.wrote_at ? `last wrote ${when(a.wrote_at)}` : undefined),
    (a) => a.project,
    (a) => `session ${sessionMark(a.session, same)}`,
  ];
  const parts: string[] = [];
  let rest = same.filter((a) => a.session !== agent.session);
  for (const step of steps) {
    if (rest.length === 0) break;
    const mine = step(agent);
    if (mine && rest.some((a) => step(a) !== mine)) parts.push(mine);
    rest = rest.filter((a) => step(a) === mine);
  }
  return parts;
}

/** The fewest last characters of `session` (four or more) that no other of `among` ends with. */
function sessionMark(session: string, among: readonly InboxCombineAgent[]): string {
  for (let n = 4; n < session.length; n++) {
    const end = session.slice(-n);
    if (!among.some((a) => a.session !== session && a.session.endsWith(end))) return end;
  }
  return session;
}

/** What `GET /api/inbox/combine` answers. With `threads=`: who can be asked; always the Combines worth showing. */
export interface InboxCombinePlan {
  serverSession: string;
  agents?: InboxCombineAgent[];
  combines: InboxCombineRecord[];
}

/** The longest the person's words for a Combine may be. */
export const INBOX_COMBINE_WORDS_MAX = 500;

/** One picked thread as the wake lists it. */
export interface InboxCombineWakeThread {
  id: string;
  subject: string;
  project: string;
  messages: number;
  /** `<message id>/<key>` and its prompt, for each open question or action item. */
  open: { ref: string; prompt: string }[];
}

/**
 * The wake's first paragraph. `key` is the Combine's id: the new thread's `idempotency_key`, which is how the Inbox
 * knows it arrived (a second send with it answers the first, so it cannot make two threads).
 */
export function inboxCombineInstruction(key: string): string {
  return `The person picked these threads in the Plannotator Inbox and asked you to combine them into one new thread. Read each one (read_thread with the id given), then start one new thread with send_message: no reply_to, a subject that names the work, and idempotency_key "${key}". In it, say where each part stands, and ask again, as questions, the open questions listed below; for one that no longer applies, say so in one line instead, so none is lost without a word. Send nothing in the old threads: once your thread arrives, the Inbox archives them, and their open questions close.`;
}

/** The paragraph after the first, only when the person typed something. */
export function inboxCombineWordsLine(words: string): string {
  return `The person added: "${inboxQuotedWords(words)}". Where it differs from the rest of this note, their words win.`;
}

/** The line for a session a command line can name (`inboxSessionRef`), as Tidy's. */
export function inboxCombineSessionLine(ref: string): string {
  return `If you send it from a shell, run \`plannotator inbox call --session ${ref} send_message …\` (\`--session\` before the action), so it writes as you.`;
}

/** The numbered list: each picked thread, then its open questions by id. */
export function inboxCombineThreadLines(threads: readonly InboxCombineWakeThread[]): string[] {
  return threads.map((thread, i) => {
    const head = `${i + 1}. ${thread.subject} · ${thread.project} (thread ${thread.id}, ${thread.messages} message${thread.messages === 1 ? "" : "s"})`;
    if (thread.open.length === 0) return head;
    return [head, "   Open questions:", ...thread.open.map((q) => `     ${q.ref}  ${q.prompt}`)].join("\n");
  });
}
