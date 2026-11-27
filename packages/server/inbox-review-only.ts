/**
 * The Inbox for code review only (docs/agent-guides/inbox-review-only.md): one setting of this computer, config.json
 * `inboxReviewOnly: true`, never shared with a linked computer. While on, Code review is on whatever its own switch
 * says, and the window and every agent follow it through one resolver (`inboxAgentWords`, packages/shared/inbox/
 * connection.ts):
 *
 * - The window shows Reviews first and hides what belongs to the full Inbox (settings `full_inbox: { on: false }`).
 * - Agents: no session-start reminder, the agent tool's and the MCP server's review-only rule (INBOX_REVIEW_ONLY_RULE),
 *   no `card` or `steps` action, and no note in agents' instructions files (inbox-review-only-notes.ts: out while on,
 *   back with the full Inbox).
 * - The one-time dialogs: no offer of a full-Inbox feature; the welcome `plannotator inbox --review` asks for on a
 *   first run (`inboxReviewWelcome.dueAt`) is the line's `review_welcome`, claimed through it.
 *
 * On the wire it is the Settings row's switch, Full Inbox: `full_inbox: { on }`, on = the full Inbox. `chosen`: the
 * person was in the mode at some point (the row shows then, so they can switch back and forth).
 */
import type { InboxCapabilitySetKey } from "@plannotator/core/inbox-types";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { inboxAgentWords, type InboxAgentWords } from "@plannotator/shared/inbox/connection";
import { REVEAL_PATIENCE_MS } from "@plannotator/shared/inbox/reveals";
import { InboxError } from "@plannotator/shared/inbox/schema";

export interface ReviewOnlyHost {
  load: () => PlannotatorConfig;
  save: (patch: Partial<PlannotatorConfig>) => unknown;
  /** Decided here instead of config.json (tests). Absent: config.json decides on every request. */
  fixed?: boolean;
  /** A release build: the Inbox keeps a line of one-time dialogs (a dev build shows none of them, the welcome included). */
  release?: boolean;
  now?: () => number;
  /** The notes follow the mode (inbox-review-only-notes.ts `sync`). */
  syncNotes: () => Promise<void>;
  /** Every window follows (`event: capabilities`). */
  changed: () => void;
  /**
   * Code review's flip is stamped as the person's (inbox-capability-set.ts `flipped`), called once the switch back to
   * the full Inbox has landed: Code review is shared again from then on, and a linked computer's flip of it made while
   * this one was code review only is older, so it never turns Code review off here afterwards.
   */
  codeReviewFlipped?: () => void;
}

/**
 * Whether a switch of the one set across linked computers (inbox-capability-set.ts) is shared from here. The mode
 * itself is never in the set (this computer's own). While code review only, Code review is held on here, so it is
 * neither given (a full-Inbox computer linked to this one never has Code review turned by it) nor taken (a flip from
 * a linked computer never ends the mode). Every other switch is shared as before; its value is kept while the mode
 * does not use it.
 */
export function reviewOnlyShares(key: InboxCapabilitySetKey, reviewOnly: boolean): boolean {
  return !(reviewOnly && key === "code_review");
}

const NOT_SAVED ="config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.";

export function createReviewOnly(host: ReviewOnlyHost) {
  /** Code review only, in effect: the setting alone. */
  const on = () => host.fixed ?? host.load().inboxReviewOnly === true;
  const chosen = () => host.fixed !== undefined || typeof host.load().inboxReviewOnly === "boolean";
  return {
    on,
    chosen,
    /** This computer's agent words, as every host builds them. */
    words: (): InboxAgentWords => inboxAgentWords({ inboxReviewOnly: on() }),
    /** The switch as Settings' Full Inbox row reads it. */
    wire: (): { full_inbox: { on: boolean; chosen?: true } } => ({ full_inbox: { on: !on(), ...(chosen() ? { chosen: true as const } : {}) } }),
    /** The welcome is open for the line (`review_welcome`): code review only, and `--review` asked for it. */
    welcomeOpen: (): boolean => on() && typeof host.load().inboxReviewWelcome?.dueAt === "string",
    /**
     * The welcome goes before the launch dialog (inbox-launch-queue.ts `after`) only while it is due and can still
     * show: open for the line, unshown, in a build that keeps the line, and not yet past the line's patience as its
     * next dialog (someone who only ever opens thread links never reaches Reviews, where it opens). Past that, the
     * launch is not held behind it any longer.
     */
    welcomeAhead: (): boolean => {
      const config = host.load();
      if (host.release !== true || !on() || typeof config.inboxReviewWelcome?.dueAt !== "string" || config.inboxReveals?.review_welcome?.shownAt) return false;
      const reveals = config.inboxReveals;
      const since = Date.parse(reveals?.waitingSince?.review_welcome ?? "");
      return !Number.isFinite(since) || (host.now ?? Date.now)() - since < REVEAL_PATIENCE_MS;
    },
    /** `POST /api/inbox/settings { full_inbox: { on } }`: on = the full Inbox (Code review stays on), off = code review only. */
    save: async (input: unknown, validateOnly = false): Promise<{ on: boolean; chosen: true }> => {
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
        throw new InboxError("validation_error", "full_inbox: { on: boolean }.", { field: "full_inbox" });
      }
      const full = (input as { on: boolean }).on;
      if (validateOnly) return { on: !on(), chosen: true };
      const was = on();
      // Code review is saved on with it both ways: switching to the full Inbox never leaves it off.
      if (host.fixed === undefined) {
        host.save({ inboxReviewOnly: !full, inboxCodeReview: true });
        const saved = host.load();
        if (saved.inboxReviewOnly !== !full || saved.inboxCodeReview !== true) throw new InboxError("config_not_saved", NOT_SAVED);
      }
      if (was && !on()) host.codeReviewFlipped?.();
      if (was !== on()) host.changed();
      await host.syncNotes();
      return { on: !on(), chosen: true };
    },
  };
}

export type InboxReviewOnly = ReturnType<typeof createReviewOnly>;
