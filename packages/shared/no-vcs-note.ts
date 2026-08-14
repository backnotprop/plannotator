/**
 * Approval-time "no version control here" note (#493).
 *
 * When a plan is APPROVED in a directory no VCS provider claims, the agent is
 * about to start editing files that nothing is tracking. Every host that
 * threads approval text back to its agent appends this note to that text.
 *
 * Two invariants the callers depend on:
 *  - Approval only. Denials already carry feedback and are never touched.
 *  - Silence on doubt. A detection failure means "assume version control is
 *    present": a false "you have no git" warning is worse than no warning.
 */

/**
 * Deliberately pinned copy: the note is the whole feature, and its wording is
 * the instruction the agent acts on. Tests match the "No version control
 * detected" substring, not this whole sentence.
 */
export const NO_VCS_APPROVAL_NOTE =
  "[Note: No version control detected in this directory. Before making changes, ask the user if they want to initialize git to enable change tracking.]";

export interface NoVcsApprovalNoteOptions {
  /** The reviewer's decision. Anything other than an approval stays silent. */
  approved: boolean;
  /**
   * Whether the working directory is under version control. Injected so each
   * runtime can use its own detection machinery (the Bun CLI detects git, jj,
   * GitButler and p4; Pi detects the providers Pi registers).
   */
  detectVcsPresent: () => boolean | Promise<boolean>;
}

/**
 * Resolve the note to append to an approval's agent-facing text.
 * Returns "" whenever nothing should be appended.
 */
export async function resolveNoVcsApprovalNote(
  options: NoVcsApprovalNoteOptions,
): Promise<string> {
  if (!options.approved) return "";

  let present: boolean;
  try {
    present = await options.detectVcsPresent();
  } catch {
    // Detection blew up (no git binary, unreadable cwd, provider error).
    // Stay silent rather than warn on a guess.
    return "";
  }

  return present ? "" : NO_VCS_APPROVAL_NOTE;
}

/** Append a resolved note to an approval message, tolerating empty inputs. */
export function appendNoVcsApprovalNote(text: string, note: string): string {
  if (!note) return text;
  if (!text) return note;
  return `${text}\n\n${note}`;
}
