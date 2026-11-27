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
 *    saved, so it goes back as they left it. The text is kept by the file it came out of (resolved through links,
 *    `edited`), not by agent: two agents sharing one file (Pi's AGENTS.md a link to Codex's) and one agent with two
 *    files (AGENTS.md and AGENTS.override.md) each keep every file's own text.
 *  - Back: each saved agent's note is put back (`auto`: never a second, marked copy beside one pasted by hand): each
 *    edited text into the file it came from, whichever agent comes first (a file that holds a section already keeps
 *    it, and a later agent sharing it only takes its record back), else Plannotator's note into the agent's file.
 *    Each agent leaves the list once its note is back, and the list goes when it is empty. Then the automatic add runs
 *    as a full Inbox's start runs it.
 *  - Left over (a read-only or hard-linked file): tried again after a minute, then twice as long each time up to an
 *    hour (`RETRY_MAX_MS`), and nothing is logged.
 *  - The person's own switch while either is going on: the list follows (that agent leaves it), so switching back gives
 *    what they last chose.
 *  - PLANNOTATOR_INBOX_NOTES=0: no write at all.
 */
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { INBOX_NOTE_AGENT_IDS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { isAbsolute } from "node:path";
import { addInboxNote, agentNoteFiles, inboxNotesDisabled, isOwnNoteBlock, noteHolderIds, removeInboxNote, type NoteChange } from "./inbox-agent-notes";
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
  /** How long until a pass that left something first tries again (then twice as long each time, up to RETRY_MAX_MS). Default a minute. */
  retryMs?: number;
  /** Tests: schedules the retry (default setTimeout, unref'd). */
  timer?: (run: () => void, ms: number) => { cancel: () => void };
}

/** Up to this many tries in one pass for one agent, each saving one more edited section (more than an agent's files). */
const TRIES = 8;
/** The longest wait between two passes that leave something (a file left read-only or hard-linked for good). */
export const RETRY_MAX_MS = 60 * 60_000;
const defaultTimer = (run: () => void, ms: number) => {
  const handle = setTimeout(run, ms);
  (handle as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(handle) };
};
const isNoteAgent = (id: string): id is InboxNoteAgentId => (INBOX_NOTE_AGENT_IDS as readonly string[]).includes(id) && id !== "cursor";

export function createAgentNotes(host: AgentNotesHost) {
  const e = host.environment;
  let queue: Promise<unknown> = Promise.resolve();
  let retry: { cancel: () => void } | null = null;
  /** The wait before the retry now scheduled (0: none since the files last matched). */
  let wait = 0;
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
    // Keyed by the file each text came out of (an absolute, resolved path).
    const edited = kept.edited && typeof kept.edited === "object" ? Object.fromEntries(Object.entries(kept.edited).filter(([file, text]) => isAbsolute(file) && typeof text === "string")) : {};
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

  /** Takes one agent's note out; true once it is out. Each edited section's text is saved, by its file, before it goes. */
  const takeOut = (agent: InboxNoteAgentId, now: NotesState): boolean => {
    for (let i = 0; i < TRIES; i++) {
      const change: NoteChange = removeInboxNote(agent, host.dataDir, e, undefined, {
        auto: true,
        removable: (block, file) => isOwnNoteBlock(block) || now.edited?.[file] === block,
      });
      if (change.ok) return true;
      // Not an edited section, or one saved already that still did not come out (the file changed meanwhile).
      if (change.edited === undefined || change.editedIn === undefined || now.edited?.[change.editedIn] === change.edited) return false;
      now.edited = { ...now.edited, [change.editedIn]: change.edited };
      if (!keep(now)) return false;
    }
    return false;
  };

  /**
   * Puts one agent's note back; true once it is. Each edited text saved for one of its files goes back into that file
   * (its target last, so its record names it); Plannotator's note goes into its target when no edited text did. A text
   * stays saved while another agent still on the list reads the same file, so whichever comes first, it is the one put
   * back, and the other only takes its record back.
   */
  const putBack = (agent: InboxNoteAgentId, now: NotesState): boolean => {
    const files = agentNoteFiles(agent, e);
    const target = files[0];
    const mine = files.filter((file) => now.edited?.[file] !== undefined && file !== target);
    if (target !== undefined && now.edited?.[target] !== undefined) mine.push(target);
    let back = true;
    // Only a note the person pasted by hand without markers counts as back too (never a second, marked copy beside it).
    const landed = (change: NoteChange) => change.ok || change.pasted === true;
    for (const file of mine) {
      if (!landed(addInboxNote(agent, host.dataDir, e, new Date(), { auto: true, block: now.edited![file]!, path: file }))) {
        back = false;
        continue;
      }
      const sharedWith = now.back.some((id) => id !== agent && isNoteAgent(id) && agentNoteFiles(id, e).includes(file));
      if (!sharedWith) {
        const { [file]: _put, ...rest } = now.edited ?? {};
        now.edited = rest;
      }
    }
    if (mine.length === 0 && !landed(addInboxNote(agent, host.dataDir, e, new Date(), { auto: true }))) back = false;
    return back;
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
      const before = JSON.stringify(now.edited ?? {});
      const back = putBack(agent, now);
      // Not put back (a read-only or hard-linked file, one changed meanwhile): kept on the list and tried again.
      if (!back) {
        settled = false;
        if (JSON.stringify(now.edited ?? {}) !== before && !keep(now)) return false;
        continue;
      }
      now = { ...now, back: now.back.filter((id) => id !== agent) };
      if (!keep(now)) return false;
    }
    if (now.back.length > 0) return settled;
    return keep(null);
  };

  /** Tries again later: after a minute, then twice as long each time while something is still left, up to an hour. */
  const later = () => {
    if (retry || host.stopped()) return;
    const first = host.retryMs ?? 60_000;
    wait = wait === 0 ? first : Math.min(wait * 2, Math.max(first, RETRY_MAX_MS));
    retry = (host.timer ?? defaultTimer)(() => {
      retry = null;
      void sync();
    }, wait);
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
      if (settled) wait = 0;
      else later();
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
        const files = agentNoteFiles(agent, e);
        if (change.ok && now && (now.back.includes(agent) || now.out.includes(agent) || files.some((file) => now.edited?.[file] !== undefined))) {
          const edited = Object.fromEntries(Object.entries(now.edited ?? {}).filter(([file]) => !files.includes(file)));
          keep({ ...now, back: now.back.filter((id) => id !== agent), out: now.out.filter((id) => id !== agent), edited });
        }
        return change;
      }),
    /** Resolves once every write queued so far is done. */
    idle: (): Promise<void> => queued(() => undefined),
    stop: () => {
      retry?.cancel();
      retry = null;
      wait = 0;
    },
  };
}

export type InboxAgentNotes = ReturnType<typeof createAgentNotes>;
