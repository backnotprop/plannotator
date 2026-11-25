/**
 * Every writer of the Inbox note in agents' instructions files, in one queue (inbox.ts makes one per Inbox): the
 * automatic add (autoAddInboxNotes), code review only's pass, and the person's own switch in Settings → Agents. One
 * write at a time, so no pass ever puts a note back that another just took out.
 *
 * Code review only (docs/agent-guides/inbox-review-only.md): while on, the notes are out; with the full Inbox, back.
 * The pass records its intent first (machine state `inboxReviewOnlyNotes`, read back before it goes on), then makes the
 * files match, and runs again at every start, every flip and on a timer while anything is left, until they do:
 *
 *  - Out: the agents that have the note (`noteHolderIds`) are saved as the ones to put back, before any file or any
 *    agent's own record changes; a failed save stops the pass. Then each note comes out with the automatic add's guards
 *    (`auto`: a read-only or hard-linked file is skipped and tried again later; one changed since it was read is not
 *    written). A section the person edited comes out too, as Settings' switch takes it, but only once its text is
 *    saved, so it goes back as they left it.
 *  - Back: each saved agent's note is put back (`auto`: never a second, marked copy beside one pasted by hand), its
 *    edited text when there was one; each agent leaves the list once its note is back, and the list goes when it is
 *    empty. Then the automatic add runs as a full Inbox's start runs it.
 *  - The person's own switch while either is going on: the list follows (that agent leaves it), so switching back gives
 *    what they last chose.
 *  - PLANNOTATOR_INBOX_NOTES=0: no write at all.
 */
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { INBOX_NOTE_AGENT_IDS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { addInboxNote, inboxNotesDisabled, isOwnNoteBlock, noteHolderIds, removeInboxNote, type NoteChange } from "./inbox-agent-notes";
import { agentHomeAllowed, agentSpec, type AgentEnvironment } from "./inbox-agents";

type NotesState = NonNullable<PlannotatorConfig["inboxReviewOnlyNotes"]>;

export interface AgentNotesHost {
  dataDir: string;
  environment: AgentEnvironment;
  /** Code review only now (read again before every write). */
  reviewOnly: () => boolean;
  load: () => PlannotatorConfig;
  save: (patch: Partial<PlannotatorConfig>) => unknown;
  /** Records these agents as asked about the note (markNotesAsked), so the automatic add never writes theirs by itself. */
  markAsked: (agents: InboxNoteAgentId[]) => Promise<unknown>;
  /** The automatic add (autoAddInboxNotes), which asks `mayWrite` right before each write. */
  autoAdd: (mayWrite: () => boolean) => Promise<unknown>;
  /** The Inbox is stopping: nothing more is written. */
  stopped: () => boolean;
  /** How long until a pass that left something tries again. Default a minute. */
  retryMs?: number;
}

/** Up to this many tries in one pass for one agent whose edited section was saved meanwhile. */
const TRIES = 3;
const isNoteAgent = (id: string): id is InboxNoteAgentId => (INBOX_NOTE_AGENT_IDS as readonly string[]).includes(id) && id !== "cursor";

export function createAgentNotes(host: AgentNotesHost) {
  const e = host.environment;
  let queue: Promise<unknown> = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** Runs `job` after every write before it; its failure never stops the queue. */
  const queued = <T>(job: () => T | Promise<T>): Promise<T> => {
    const run = queue.then(job);
    queue = run.catch(() => undefined);
    return run;
  };
  const state = (): NotesState | null => {
    const kept = host.load().inboxReviewOnlyNotes;
    if (!kept || typeof kept !== "object" || (kept.for !== "review_only" && kept.for !== "full")) return null;
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && isNoteAgent(id)) : []);
    const edited = kept.edited && typeof kept.edited === "object" ? Object.fromEntries(Object.entries(kept.edited).filter(([id, text]) => isNoteAgent(id) && typeof text === "string")) : {};
    return { for: kept.for, back: ids(kept.back), out: ids(kept.out), edited };
  };
  /** Saves the state and reads it back: false when it did not land (nothing may change then). */
  const keep = (next: NotesState | null): boolean => {
    host.save({ inboxReviewOnlyNotes: next ?? undefined });
    const now = state();
    if (next === null) return now === null;
    return JSON.stringify(now) === JSON.stringify({ ...next, edited: next.edited ?? {} });
  };
  const writable = () => agentHomeAllowed(e) && !inboxNotesDisabled(e.env) && !host.stopped();

  /** Takes one agent's note out; true once it is out. Its edited text is saved before it goes. */
  const takeOut = (agent: InboxNoteAgentId, now: NotesState): boolean => {
    for (let i = 0; i < TRIES; i++) {
      const change: NoteChange = removeInboxNote(agent, host.dataDir, e, undefined, {
        auto: true,
        removable: (block) => isOwnNoteBlock(block) || now.edited?.[agent] === block,
      });
      if (change.ok) return true;
      if (change.edited === undefined) return false;
      now.edited = { ...now.edited, [agent]: change.edited };
      if (!keep(now)) return false;
    }
    return false;
  };

  /** One pass; true when the files match the mode (nothing left to try). */
  const pass = async (): Promise<boolean> => {
    if (!writable()) return true;
    let now = state();
    if (host.reviewOnly()) {
      if (now?.for !== "review_only") {
        // Intent first: everyone who has the note now goes back with the full Inbox, and those still to go back from
        // a switch back that did not finish stay on the list.
        const holders = noteHolderIds({ dataDir: host.dataDir, environment: e }).filter(isNoteAgent);
        const next: NotesState = { for: "review_only", back: [...new Set([...(now?.back ?? []), ...holders])], out: holders, edited: now?.edited ?? {} };
        if (!keep(next)) return false;
        // They count as asked, so the automatic add never writes one of them by itself.
        await host.markAsked(next.back.filter(isNoteAgent));
        now = next;
      }
      let settled = true;
      for (const agent of [...now.out]) {
        if (!host.reviewOnly() || !writable()) return false;
        if (!isNoteAgent(agent) || !takeOut(agent, now)) {
          settled = false;
          continue;
        }
        now = { ...now, out: now.out.filter((id) => id !== agent) };
        if (!keep(now)) return false;
      }
      return settled;
    }
    if (!now) return true;
    if (now.for !== "full") {
      now = { ...now, for: "full", out: [] };
      if (!keep(now)) return false;
    }
    let settled = true;
    for (const agent of [...now.back]) {
      if (host.reviewOnly() || !writable()) return false;
      // Not on this computer now: kept, and put back when it is.
      if (!isNoteAgent(agent) || !agentSpec(agent).detect(e)) {
        settled = false;
        continue;
      }
      const text = now.edited?.[agent];
      const change = addInboxNote(agent, host.dataDir, e, new Date(), { auto: true, ...(text !== undefined ? { block: text } : {}) });
      // Not put back (a read-only or hard-linked file, one changed meanwhile): kept on the list and tried again. Only a
      // note the person pasted by hand without markers counts as back (never a second, marked copy beside it).
      if (!change.ok && !change.pasted) {
        settled = false;
        continue;
      }
      const { [agent]: _put, ...edited } = now.edited ?? {};
      now = { ...now, back: now.back.filter((id) => id !== agent), edited };
      if (!keep(now)) return false;
    }
    if (now.back.length > 0) return settled;
    return keep(null);
  };

  const later = () => {
    if (retry || host.stopped()) return;
    retry = setTimeout(() => {
      retry = null;
      void sync();
    }, host.retryMs ?? 60_000);
    (retry as { unref?: () => void }).unref?.();
  };

  /** Code review only's pass, in the queue; tried again later while anything is left. */
  const sync = (): Promise<void> =>
    queued(async () => {
      let settled = false;
      try {
        settled = await pass();
      } catch {
        settled = false;
      }
      if (!settled) later();
    });

  return {
    sync,
    /** The automatic add, in the queue: never while code review only, and asked again right before each write. */
    auto: (): Promise<void> =>
      queued(async () => {
        if (host.stopped() || host.reviewOnly() || state() !== null) return;
        try {
          await host.autoAdd(() => !host.stopped() && !host.reviewOnly());
        } catch {
          // Tried again at the next start or run.
        }
      }),
    /** The person's own switch (Settings → Agents, the note dialog), in the queue; the list follows a change that landed. */
    person: <T extends NoteChange>(agent: InboxNoteAgentId, write: () => T): Promise<T> =>
      queued(() => {
        const change = write();
        const now = state();
        if (change.ok && now && (now.back.includes(agent) || now.out.includes(agent) || now.edited?.[agent] !== undefined)) {
          const { [agent]: _chosen, ...edited } = now.edited ?? {};
          keep({ ...now, back: now.back.filter((id) => id !== agent), out: now.out.filter((id) => id !== agent), edited });
        }
        return change;
      }),
    /** Resolves once every write queued so far is done. */
    idle: (): Promise<void> => queued(() => undefined),
    stop: () => {
      if (retry) clearTimeout(retry);
      retry = null;
    },
  };
}

export type InboxAgentNotes = ReturnType<typeof createAgentNotes>;
