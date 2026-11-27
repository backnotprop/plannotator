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
 *    edited text into the file it came from, whichever agent comes first, else Plannotator's note into the agent's
 *    file. Once a text is in its file it is done for every agent: each other agent on the list reading that file takes
 *    its record back then. Each agent leaves the list once its note is back, and the list goes when it is empty. Then
 *    the automatic add runs as a full Inbox's start runs it.
 *  - Never lost: a text that cannot go back (its file holds another section now; no agent reads its file any more; a
 *    file other than the target the person deleted, never made again, when the target cannot take it) is kept aside
 *    in `inboxNoteSectionsKept` (the KEPT_MAX newest), in the same save that takes it off the list.
 *  - Left over (a read-only or hard-linked file): tried again after a minute, then twice as long each time up to an
 *    hour (`RETRY_MAX_MS`), and nothing is logged.
 *  - The person's own switch while either is going on: the list follows (that agent leaves it), so switching back gives
 *    what they last chose. Turning a note on puts back their own text saved for its files, not Plannotator's note.
 *  - PLANNOTATOR_INBOX_NOTES=0: no write at all.
 */
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { INBOX_NOTE_AGENT_IDS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { addInboxNote, agentNoteFiles, inboxNotesDisabled, isOwnNoteBlock, noteHolderIds, removeInboxNote, type NoteChange } from "./inbox-agent-notes";
import { agentHomeAllowed, agentSpec, type AgentEnvironment } from "./inbox-agents";

type NotesState = NonNullable<PlannotatorConfig["inboxReviewOnlyNotes"]>;
type KeptSection = NonNullable<PlannotatorConfig["inboxNoteSectionsKept"]>[number];

/** The most edited sections kept aside (`inboxNoteSectionsKept`) that could not be put back; the oldest goes first. */
export const KEPT_MAX = 16;

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
  const keptAside = (): KeptSection[] => {
    const list = host.load().inboxNoteSectionsKept;
    return Array.isArray(list) ? list.filter((item): item is KeptSection => !!item && typeof item === "object" && typeof item.file === "string" && typeof item.text === "string" && typeof item.at === "string") : [];
  };
  /**
   * Saves the state and reads it back: false when it did not land (nothing may change then). `aside`: texts that leave
   * `edited` without being put back, kept in `inboxNoteSectionsKept` (the KEPT_MAX newest) in the same save.
   */
  const keep = (next: NotesState | null, aside: Record<string, string> = {}): boolean => {
    const set = Object.entries(aside);
    const at = new Date().toISOString();
    const list = set.length === 0 ? null : [...keptAside().filter((item) => !set.some(([file, text]) => item.file === file && item.text === text)), ...set.map(([file, text]) => ({ file, text, at }))].slice(-KEPT_MAX);
    host.save({ inboxReviewOnlyNotes: next ?? undefined, ...(list ? { inboxNoteSectionsKept: list } : {}) });
    if (list && JSON.stringify(keptAside()) !== JSON.stringify(list)) return false;
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

  const drop = (now: NotesState, file: string) => {
    const { [file]: _gone, ...rest } = now.edited ?? {};
    now.edited = rest;
  };

  /**
   * The text saved for `file` is in `into` now (put back, or there already): it is done, for every agent. Each other
   * agent on the list that reads `into` takes its record back with it, and leaves the list when nothing else is saved
   * for its files, so no later put-back ever writes that text again.
   */
  const placed = (agent: InboxNoteAgentId, file: string, into: string, text: string, now: NotesState) => {
    drop(now, file);
    for (const id of [...now.back]) {
      if (id === agent || !isNoteAgent(id) || !agentNoteFiles(id, e).includes(into)) continue;
      const follow = addInboxNote(id, host.dataDir, e, new Date(), { block: text, path: into });
      if (follow.ok && follow.action !== "kept-edited" && !agentNoteFiles(id, e).some((other) => now.edited?.[other] !== undefined)) now.back = now.back.filter((other) => other !== id);
    }
  };

  /**
   * Puts one agent's note back; `back` once it is. Each edited text saved for one of its files goes back into that file
   * (its target last, so its record names it); Plannotator's note goes into its target when no edited text did. A text
   * that cannot go back is kept aside (`aside`, then `inboxNoteSectionsKept`), never dropped: its file holds another
   * section now, or it is a file other than the target that the person deleted (never made again; the text goes into
   * the target instead when the target has no section and no text of its own saved).
   */
  const putBack = (agent: InboxNoteAgentId, now: NotesState, aside: Record<string, string>, auto = true): { back: boolean; change: NoteChange | null } => {
    const files = agentNoteFiles(agent, e);
    const target = files[0];
    const mine = files.filter((file) => now.edited?.[file] !== undefined && file !== target);
    if (target !== undefined && now.edited?.[target] !== undefined) mine.push(target);
    let back = true;
    let last: NoteChange | null = null;
    // Only a note the person pasted by hand without markers counts as back too (never a second, marked copy beside it).
    const landed = (change: NoteChange) => change.ok || change.pasted === true;
    for (const file of mine) {
      const text = now.edited?.[file];
      if (text === undefined) continue;
      let into = file;
      if (file !== target && !existsSync(file)) {
        if (target === undefined || now.edited?.[target] !== undefined) {
          aside[file] = text;
          drop(now, file);
          continue;
        }
        into = target;
      }
      last = addInboxNote(agent, host.dataDir, e, new Date(), { auto, block: text, path: into });
      if (!landed(last)) {
        back = false;
        continue;
      }
      if (last.ok && last.action !== "kept-edited") placed(agent, file, into, text, now);
      else {
        aside[file] = text;
        drop(now, file);
      }
    }
    if (last === null) {
      last = addInboxNote(agent, host.dataDir, e, new Date(), { auto });
      if (!landed(last)) back = false;
    }
    return { back, change: last };
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
      // Back already: it took its record back with a shared file's text another agent put back (placed).
      if (!now.back.includes(agent)) continue;
      // Not on this computer now: kept, and put back when it is.
      if (!isNoteAgent(agent) || !agentSpec(agent).detect(e)) {
        settled = false;
        continue;
      }
      const before = JSON.stringify(now);
      const aside: Record<string, string> = {};
      const { back } = putBack(agent, now, aside);
      // Not put back (a read-only or hard-linked file, one changed meanwhile): kept on the list and tried again.
      if (!back) {
        settled = false;
        if (JSON.stringify(now) !== before && !keep(now, aside)) return false;
        continue;
      }
      now = { ...now, back: now.back.filter((id) => id !== agent) };
      if (!keep(now, aside)) return false;
    }
    if (now.back.length > 0) return settled;
    // A text still saved was put back nowhere (no agent reads its file now, a link pointed elsewhere): kept aside.
    return keep(null, now.edited ?? {});
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
    /**
     * The person turns a note on (Settings → Agents, the note dialog), in the queue. Where the list saved their own text
     * for one of its files, that goes back as they left it (not Plannotator's note), and is done for every agent
     * reading that file; the list follows a change that landed.
     */
    add: (agent: InboxNoteAgentId): Promise<NoteChange> =>
      queued(() => {
        const now = state();
        if (!now || !agentNoteFiles(agent, e).some((file) => now.edited?.[file] !== undefined)) {
          const change = addInboxNote(agent, host.dataDir, e);
          if (change.ok && now && (now.back.includes(agent) || now.out.includes(agent))) keep({ ...now, back: now.back.filter((id) => id !== agent), out: now.out.filter((id) => id !== agent) });
          return change;
        }
        const before = JSON.stringify(now);
        const aside: Record<string, string> = {};
        const { back, change } = putBack(agent, now, aside, false);
        if (back) Object.assign(now, { back: now.back.filter((id) => id !== agent), out: now.out.filter((id) => id !== agent) });
        if (JSON.stringify(now) !== before) keep(now, aside);
        return change!;
      }),
    /**
     * The person turns a note off (Settings → Agents), in the queue; the list follows a change that landed. A text saved
     * for one of its files stays saved while another agent on the list reads that file, else it is kept aside.
     */
    person: <T extends NoteChange>(agent: InboxNoteAgentId, write: () => T): Promise<T> =>
      queued(() => {
        const change = write();
        const now = state();
        const files = agentNoteFiles(agent, e);
        if (change.ok && now && (now.back.includes(agent) || now.out.includes(agent) || files.some((file) => now.edited?.[file] !== undefined))) {
          const back = now.back.filter((id) => id !== agent);
          const read = (file: string) => back.some((id) => isNoteAgent(id) && agentNoteFiles(id, e).includes(file));
          const edited: Record<string, string> = {};
          const aside: Record<string, string> = {};
          for (const [file, text] of Object.entries(now.edited ?? {})) {
            if (!files.includes(file) || read(file)) edited[file] = text;
            else aside[file] = text;
          }
          keep({ ...now, back, out: now.out.filter((id) => id !== agent), edited }, aside);
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
