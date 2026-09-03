/**
 * Pure state→spec mapping for the unified header decision control.
 *
 * No React, no DOM, no imports — this is what keeps the state matrix testable
 * in the plain `bun test` lane and keeps "both apps and both states are data,
 * not forked components" true. `DecisionControl.tsx` renders whatever this
 * returns; the apps translate ids into handlers.
 *
 * NOT host-supported surface: like ActionMenu/ConfirmDialog, this module is
 * app-shared chrome and is deliberately absent from the README supported-import
 * list and the strict-consumer tsconfig.
 *
 * Labels, subtitles and confirm strings are the approved prototype's
 * (DESIGN_final-proposal.html `spec()`), authoritative over any older branch
 * or mock copy — except where a later maintainer ruling supersedes it: the
 * non-gate empty menu carries ONE composer ("Send a note…"), and no
 * user-facing string uses an em dash.
 */

export type DecisionActionId =
  | 'primary'              // the left segment
  | 'note-with-approval'   // "Approve with a note…" (approval flows only)
  | 'request-changes'      // "Request changes…"
  | 'note-with-feedback'   // "Send with a note…"
  | 'approve-with-notes'   // review + gate-annotate; capability-gated
  | 'discard-and-finish';  // "Done/Approve, discard n annotations…"

export type DecisionTone = 'success' | 'primary' | 'neutral' | 'destructive';

export interface DecisionPrimary {
  id: 'primary';
  label: string;            // 'Done' | 'Approve' | 'Send Feedback' | 'Post Comments'
  shortLabel?: string;      // 'Send' — the lg-breakpoint label
  mobileLabel?: string;     // compact/touch row label
  title: string;            // tooltip / aria description
  tone: Exclude<DecisionTone, 'destructive'>;
  icon?: 'check' | 'send';
  count?: number;           // rendered as the inline pill; omitted when 0
  /**
   * Platform self-approval (PR6, §3.4): rendered dimmed but NOT disabled.
   * The reason surfaces through the shared Tooltip + aria-describedby (the
   * native title is deliberately dropped when muted, pinned by test), and
   * every invocation path (click, Mod+Enter, compact row) is a no-op. The
   * caret stays live so the menu's non-approve paths remain reachable.
   */
  muted?: boolean;
}

export interface DecisionComposer {
  title: string;            // popover back-button title, e.g. 'Send with a note'
  actionLabel: string;      // the composer's own button, e.g. 'Send feedback with note'
  tone: Exclude<DecisionTone, 'destructive'>;
  icon?: 'check' | 'send';
  placeholder: string;      // 'Add a note...'
}

export interface DecisionConfirm {
  title: string;
  message: string;
  confirmText: string;
}

export interface DecisionMenuItem {
  id: Exclude<DecisionActionId, 'primary'>;
  label: string;
  subtitle: string;
  tone: DecisionTone;
  icon?: 'check' | 'send';
  dividerBefore?: boolean;
  composer?: DecisionComposer;   // present ⇒ the item morphs the popover
  confirm?: DecisionConfirm;     // present ⇒ the item raises one confirm
  /**
   * Platform self-approval (PR6, §3.4): the row renders disabled with the
   * reason in its subtitle. Muted rather than removed, so the menu still
   * documents the path and no state is a dead end (the non-approve rows
   * stay live).
   */
  muted?: boolean;
}

export interface DecisionSpec {
  primary: DecisionPrimary;
  items: DecisionMenuItem[];
}

export interface DecisionSpecInput {
  app: 'annotate' | 'review';
  /** Annotate: `gate`. Review: always true — review's primary decision IS approval. */
  gate: boolean;
  /** The count rendered in the pill and interpolated into labels. */
  count: number;
  /**
   * Whether there is anything to send. Deliberately separate from `count`:
   * annotate counts direct edits / saved-file changes / attachments as
   * feedback with count 0 (`hasFeedbackContent` in the annotate app).
   */
  hasFeedback: boolean;
  /** Does the runtime deliver feedback on approve? Gates every approve-carrying item. */
  approvalNotesSupported: boolean;
  /**
   * M1 ruling: the session's feedback was already delivered through the
   * annotate agent terminal, which is why `hasFeedback` reads false. The
   * empty-flip state keeps its `Done` primary AND its transport (the outer
   * agent's stdout consumer may never have seen the terminal delivery, so
   * the full payload still posts) — only the copy changes, because "reviewed
   * with no feedback" would be a lie in that state. Copy is free prose,
   * NOT frozen.
   */
  feedbackDelivered?: boolean;
  /**
   * PR6 (§3.4): presence selects the platform (PR/MR destination) arm — the
   * same DecisionSpec shape with NO composer and NO confirm items, ever:
   * every platform action opens the existing ReviewSubmissionDialog, whose
   * own general-comment textarea is the only note field on that side (a
   * second composer would double-post via buildFileScopedBody).
   * `approvalNotesSupported` is deliberately ignored by this arm — the
   * platform posts to the forge API natively — so approve-carrying items
   * gate only on `selfAuthored`, muted rather than removed.
   */
  platform?: DecisionPlatformInput;
}

export interface DecisionPlatformInput {
  /** Platform display name ('GitHub' / 'GitLab') — named in the self-approval tooltip. */
  label: string;
  /** The PR/MR noun ('PR' / 'MR') the short mute reason uses. */
  mrLabel: string;
  /** The viewer authored this PR/MR: approve paths mute, never disappear. */
  selfAuthored: boolean;
}

export const DECISION_NOTE_PLACEHOLDER = 'Add a note...';

function annotationNoun(count: number): string {
  return count === 1 ? 'annotation' : 'annotations';
}

/**
 * The empty state: no feedback to send, the primary is the positive finish.
 * `approvalFlow` (gate annotate, or review) makes it `Approve`; plain annotate
 * gets `Done`.
 */
function buildEmptySpec(input: DecisionSpecInput, approvalFlow: boolean): DecisionSpec {
  // "Approve with a note…" carries a note on the approve channel, which four
  // runtimes still discard — it renders only where the advert says delivery
  // works (never an item that silently drops content). Non-gate annotate has
  // no approve channel and no positive-note item at all: the maintainer ruled
  // the old "Done with a note…" / "Request changes…" pair collapsed into the
  // single "Send a note…" below, because their only difference was framing on
  // the same /api/feedback transport.
  const positive: DecisionMenuItem | null = approvalFlow && input.approvalNotesSupported
    ? {
        id: 'note-with-approval',
        label: 'Approve with a note…',
        subtitle: 'Approve and send a short note with it',
        tone: 'success',
        icon: 'check',
        composer: {
          title: 'Approve with a note',
          actionLabel: 'Approve and send note',
          tone: 'success',
          icon: 'check',
          placeholder: DECISION_NOTE_PLACEHOLDER,
        },
      }
    : null;

  const requestChanges: DecisionMenuItem = approvalFlow
    ? {
        id: 'request-changes',
        // Frozen copy (maintainer-approved): 'Request changes…'.
        label: 'Request changes…',
        subtitle: 'Write overall feedback, sent as a change request',
        tone: 'primary',
        icon: 'send',
        dividerBefore: positive !== null,
        composer: {
          title: 'Request changes',
          actionLabel: 'Send as feedback',
          tone: 'primary',
          icon: 'send',
          placeholder: DECISION_NOTE_PLACEHOLDER,
        },
      }
    : {
        // Maintainer ruling (empty-menu collapse): the one non-gate composer.
        // Same id and route as the old change request (plain /api/feedback,
        // no approval framing) — only the copy is new. Free prose, NOT frozen.
        id: 'request-changes',
        label: 'Send a note…',
        subtitle: 'Write a note and send it as feedback',
        tone: 'primary',
        icon: 'send',
        dividerBefore: false,
        composer: {
          title: 'Send a note',
          actionLabel: 'Send as feedback',
          tone: 'primary',
          icon: 'send',
          placeholder: DECISION_NOTE_PLACEHOLDER,
        },
      };

  return {
    primary: approvalFlow
      ? {
          id: 'primary',
          // Frozen copy (maintainer-approved): 'Approve'.
          label: 'Approve',
          title: 'Approve: no changes requested',
          tone: 'success',
          icon: 'check',
        }
      : {
          id: 'primary',
          // Frozen copy (maintainer-approved): 'Done'.
          label: 'Done',
          // M1 ruling: in the agent-terminal delivered state the transport is
          // unchanged (the full payload still posts, because the outer agent
          // on stdout may never have seen the terminal delivery), so the
          // tooltip must not claim "no feedback". Free prose, NOT frozen.
          title: input.feedbackDelivered
            ? 'Finish: sends the session record (feedback already shared in the terminal)'
            : 'Finish: records that you reviewed with no feedback',
          // Maintainer ruling (post-demo): Done without a gate is a positive
          // finish, NOT an approval — no success tone, no check icon, so it
          // can never be mistaken for the gate/review Approve.
          tone: 'neutral',
        },
    items: positive ? [positive, requestChanges] : [requestChanges],
  };
}

/**
 * The feedback state: something to send, the primary is `Send Feedback`.
 * Identical across apps; only the discard item's verb follows the flow.
 */
function buildFeedbackSpec(input: DecisionSpecInput, approvalFlow: boolean): DecisionSpec {
  const { count } = input;
  const noun = annotationNoun(count);

  const items: DecisionMenuItem[] = [
    {
      id: 'note-with-feedback',
      label: 'Send with a note…',
      subtitle:
        count > 0
          ? `Add an overall note on top of your ${count} ${noun}`
          : 'Add an overall note on top of your feedback',
      tone: 'primary',
      icon: 'send',
      composer: {
        title: 'Send with a note',
        actionLabel: 'Send feedback with note',
        tone: 'primary',
        icon: 'send',
        placeholder: DECISION_NOTE_PLACEHOLDER,
      },
    },
  ];

  // The divider separates "send" alternates from "approve away" alternates —
  // it sits before whichever approve-flavoured item comes first.
  let dividerPending = true;

  // Capability-gated only (F2 ruling, maintainer default pending final
  // confirmation): at count 0 the feedback is direct edits / saved-file
  // changes / attachments, and a capable approve transport delivers those too,
  // so the item stays offered with zero-form copy — no "0 annotations"
  // language. Subtitles are free prose, NOT frozen.
  if (approvalFlow && input.approvalNotesSupported) {
    items.push({
      id: 'approve-with-notes',
      // Frozen copy (maintainer-approved): 'Approve with notes'.
      label: 'Approve with notes',
      subtitle:
        count > 0
          ? `Approve; your ${count} ${noun} ride along as non-blocking guidance`
          : 'Approve; your edits and attachments ride along as non-blocking guidance',
      tone: 'success',
      icon: 'check',
      dividerBefore: dividerPending,
    });
    dividerPending = false;
  }

  // Destructive by definition — it throws the annotations away — so it always
  // carries the one confirm the new model keeps. With count 0 there is nothing
  // to discard and the item is omitted.
  if (count > 0) {
    items.push({
      id: 'discard-and-finish',
      label: approvalFlow
        ? `Approve, discard ${count} ${noun}…`
        : `Done, discard ${count} ${noun}…`,
      subtitle: 'Asks to confirm: the annotations are not sent',
      tone: 'destructive',
      icon: 'check',
      dividerBefore: dividerPending,
      // L5: neutral wording — the count can include findings from other
      // tools, and the non-gate record still carries any direct edits.
      // Free prose, NOT frozen.
      confirm: approvalFlow
        ? {
            title: `Discard ${count} ${noun} and approve?`,
            message:
              'These annotations are change requests, including any from other tools. Approving without them tells the agent no changes are needed.',
            // Frozen copy (maintainer-approved): 'Discard & approve'.
            confirmText: 'Discard & approve',
          }
        : {
            title: `Discard ${count} ${noun} and finish?`,
            message:
              'These annotations are change requests, including any from other tools. Finishing without them sends a positive review record; any direct edits still ride along.',
            // Frozen copy (maintainer-approved): 'Discard & finish'.
            confirmText: 'Discard & finish',
          },
    });
  }

  return {
    primary: {
      id: 'primary',
      // Frozen copy (maintainer-approved): 'Send Feedback'.
      label: 'Send Feedback',
      shortLabel: 'Send',
      mobileLabel: 'Send feedback',
      title: 'Send your feedback to the agent',
      tone: 'primary',
      icon: 'send',
      count: count > 0 ? count : undefined,
    },
    items,
  };
}

/**
 * The platform (PR) arm — PR6, §3.4, per the approved DESIGN_header-pr-mode
 * mock. Reuses the agent ids so the handler Record stays closed, but every
 * item is composer-less and confirm-less: labels tell the reviewer which mode
 * the ReviewSubmissionDialog opens in, nothing more. `discard-and-finish` is
 * never emitted — the dialog owns what happens to unsent annotations.
 */
function buildPlatformSpec(input: DecisionSpecInput, platform: DecisionPlatformInput): DecisionSpec {
  const { count } = input;
  const { selfAuthored } = platform;
  const noun = platform.mrLabel === 'MR' ? 'merge request' : 'pull request';
  // Frozen copy (maintainer-approved): the self-approval mute reason.
  const selfReason = `You can't approve your own ${noun} on ${platform.label}.`;
  const selfReasonShort = `You can't approve your own ${platform.mrLabel}`;

  if (!input.hasFeedback) {
    return {
      primary: {
        id: 'primary',
        // Frozen copy (maintainer-approved): 'Approve'.
        label: 'Approve',
        title: selfAuthored ? selfReason : 'Approve: no changes needed',
        tone: 'success',
        icon: 'check',
        ...(selfAuthored ? { muted: true } : {}),
      },
      items: [
        {
          id: 'note-with-approval',
          // Approved design (PR6 detail confirmed): the empty-state platform
          // menu is "Approve with a comment…" + "Request changes…".
          label: 'Approve with a comment…',
          subtitle: selfAuthored
            ? selfReasonShort
            : 'Opens the submission dialog; the comment rides the review body',
          tone: 'success',
          icon: 'check',
          ...(selfAuthored ? { muted: true } : {}),
        },
        {
          id: 'request-changes',
          // Frozen copy (maintainer-approved): 'Request changes…'.
          label: 'Request changes…',
          subtitle: 'Overall feedback, zero line comments, via the dialog',
          tone: 'primary',
          icon: 'send',
          dividerBefore: true,
        },
      ],
    };
  }

  return {
    primary: {
      id: 'primary',
      // Frozen copy (maintainer-approved): 'Post Comments'.
      label: 'Post Comments',
      shortLabel: 'Post',
      mobileLabel: 'Post comments',
      title: `Post review to ${platform.label}`,
      tone: 'primary',
      icon: 'send',
      count: count > 0 ? count : undefined,
    },
    items: [
      {
        id: 'approve-with-notes',
        label: 'Approve with comments…',
        subtitle: selfAuthored ? selfReasonShort : 'Submission dialog in approve mode',
        tone: 'success',
        icon: 'check',
        ...(selfAuthored ? { muted: true } : {}),
      },
      {
        id: 'note-with-feedback',
        label: 'Post comments, then…',
        subtitle: 'Request changes or stay neutral, chosen in the dialog',
        tone: 'primary',
        icon: 'send',
        dividerBefore: true,
      },
    ],
  };
}

export function buildDecisionSpec(input: DecisionSpecInput): DecisionSpec {
  // PR6 (§3.4): the platform destination maps onto the same spec shape with
  // no composer items; presence of the arm selects it outright.
  if (input.platform) return buildPlatformSpec(input, input.platform);
  // Review's primary positive decision IS approval, gate flag or not.
  const approvalFlow = input.app === 'review' || input.gate;
  return input.hasFeedback
    ? buildFeedbackSpec(input, approvalFlow)
    : buildEmptySpec(input, approvalFlow);
}
