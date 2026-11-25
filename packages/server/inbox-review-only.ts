/**
 * The Inbox for code review only (docs/agent-guides/inbox-review-only.md): one setting, config.json `inboxReviewOnly`,
 * that takes effect while Code review is on. The window and every agent follow it:
 *
 * - The window shows Reviews first and hides what belongs to the full Inbox (settings `full_inbox: { on: false }`).
 * - Agents: no session-start reminder (resolveInboxReminder), the agent tool's and the MCP server's review-only rule
 *   (INBOX_REVIEW_ONLY_RULE), and no note in agents' instructions files. Switching to code review only takes the notes
 *   out (only their own marked sections, as Settings → Agents' switch does) and keeps which agents had one; switching
 *   back puts those back, then writes the ones a full Inbox writes by itself (autoAddInboxNotes).
 * - The welcome dialog `plannotator inbox --review` asks for on a first run (`inboxReviewWelcome.dueAt`): shown once,
 *   claimed by the window that shows it (`review_welcome`).
 *
 * On the wire it is the Settings row's switch, Full Inbox: `full_inbox: { on }`, on = the full Inbox. `chosen`: the
 * person chose either way at some point (the row shows then, so they can switch back and forth). One of the shared
 * capability switches (inbox-capability-set.ts), so a flip on one linked computer applies on all of them.
 */
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { InboxError } from "@plannotator/shared/inbox/schema";

export interface ReviewOnlyHost {
  load: () => PlannotatorConfig;
  save: (patch: Partial<PlannotatorConfig>) => unknown;
  /** Code review as the Inbox reads it now. */
  codeReviewOn: () => boolean;
  /** Turns Code review on as its Settings row does (every window follows). */
  turnOnCodeReview: () => unknown;
  /** Decided here instead of config.json (tests). Absent: config.json decides on every request. */
  fixed?: boolean;
  notes: {
    /** Takes the Inbox note out of every agent's instructions file that has it; the agents whose note came out. */
    hide: () => string[];
    /** Puts the note back for these agents. */
    restore: (agents: readonly string[]) => void;
    /** What a full Inbox writes by itself (autoAddInboxNotes). */
    auto: () => Promise<unknown>;
  };
  /** Every window follows (`event: capabilities`). */
  changed: () => void;
  now?: () => Date;
}

const NOT_SAVED = "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.";

export function createReviewOnly(host: ReviewOnlyHost) {
  const saved = () => host.fixed ?? host.load().inboxReviewOnly === true;
  /** Code review only, in effect: the setting, with Code review on. */
  const on = () => saved() && host.codeReviewOn();
  const chosen = () => host.fixed !== undefined || typeof host.load().inboxReviewOnly === "boolean";
  // One notes pass at a time, so two quick flips never write a file twice at once.
  let notesPass: Promise<void> = Promise.resolve();
  /** The notes follow the mode: out while code review only, back with the full Inbox. Safe to call any time. */
  const syncNotes = (): Promise<void> => {
    notesPass = notesPass.then(async () => {
      try {
        const kept = host.load().inboxReviewOnlyNotes;
        const out = Array.isArray(kept);
        if (on() && !out) host.save({ inboxReviewOnlyNotes: host.notes.hide() });
        else if (!on() && out) {
          host.notes.restore(kept.filter((id): id is string => typeof id === "string"));
          host.save({ inboxReviewOnlyNotes: undefined });
          await host.notes.auto();
        }
      } catch {
        // Tried again at the next flip or start.
      }
    });
    return notesPass;
  };
  const welcome = () => host.load().inboxReviewWelcome;
  return {
    on,
    /** The setting alone (what a linked computer is given), Code review or not. */
    saved,
    chosen,
    /** The switch as Settings' Full Inbox row reads it. */
    wire: (): { full_inbox: { on: boolean; chosen?: true } } => ({ full_inbox: { on: !on(), ...(chosen() ? { chosen: true as const } : {}) } }),
    /** The welcome dialog is due on this load (only to a window that has not claimed it). */
    welcomeWire: (): { review_welcome?: true } => {
      const w = welcome();
      return on() && typeof w?.dueAt === "string" && !w.shownAt ? { review_welcome: true } : {};
    },
    /** A window showed the welcome: it never shows again. */
    welcomeSeen: (input: unknown) => {
      if (input !== true) throw new InboxError("validation_error", "review_welcome: true.", { field: "review_welcome" });
      const w = welcome();
      if (w?.dueAt && !w.shownAt) host.save({ inboxReviewWelcome: { ...w, shownAt: (host.now?.() ?? new Date()).toISOString() } });
    },
    syncNotes,
    /** `POST /api/inbox/settings { full_inbox: { on } }`: on = the full Inbox, off = code review only (Code review turns on with it). */
    save: async (input: unknown, validateOnly = false): Promise<{ on: boolean; chosen: true }> => {
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
        throw new InboxError("validation_error", "full_inbox: { on: boolean }.", { field: "full_inbox" });
      }
      const full = (input as { on: boolean }).on;
      if (validateOnly) return { on: !on(), chosen: true };
      const was = on();
      if (!full && !host.codeReviewOn()) await host.turnOnCodeReview();
      host.save({ inboxReviewOnly: !full });
      if (host.fixed === undefined && host.load().inboxReviewOnly !== !full) throw new InboxError("config_not_saved", NOT_SAVED);
      if (was !== on()) host.changed();
      await syncNotes();
      return { on: !on(), chosen: true };
    },
  };
}

export type InboxReviewOnly = ReturnType<typeof createReviewOnly>;
