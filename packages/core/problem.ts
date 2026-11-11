/**
 * One shape for something that went wrong, as the person sees it (the errors
 * system, first slice: the pull request card's outside-tool states).
 *
 * - `code` is stable and dotted (`tool.signed_out`); windows, tests and later
 *   reports key on it, never on the words.
 * - `title` is the bold line (what happened, to what); `detail` the muted line
 *   (what it means, what to do). Both are finished words from the one table
 *   (`problem-words.ts`), filled on the server, so every surface says the same.
 * - `action` is at most one next step, from a fixed list.
 * - What the other program printed, its exit and how long it ran never travel:
 *   they stay on the server (`ProblemDiag`).
 *
 * Pure: no runtime APIs, so the window, the servers (Bun and Pi) and the tools share it.
 */

export type ProblemKind = "tool";

export type ProblemAction =
  /** A command the person runs in a terminal: shown in full, with Copy. */
  | { kind: "copy_command"; value: string }
  /** A page to open (an install page, the PR on its forge). */
  | { kind: "open_url"; value: string; label: string }
  /** Ask again now. */
  | { kind: "retry" };

export interface Problem {
  code: string;
  kind: ProblemKind;
  title: string;
  detail: string;
  action?: ProblemAction;
  /** When it was seen (ISO). */
  at: string;
}

/** What the server keeps about a problem and never sends: the other program's own words and how it ended. */
export interface ProblemDiag {
  /** The tool's last non-empty line of output, at most 300 characters. */
  last_line: string | null;
  exit: number | null;
  ms: number | null;
}

const ACTIONS = new Set(["copy_command", "open_url", "retry"]);

/**
 * A problem from the wire, or null when `value` is not one: a window reads an answer from a newer or older server, so
 * anything it does not understand (a missing field, an action it does not know) is dropped, never drawn half.
 */
export function problemOf(value: unknown): Problem | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.code !== "string" || typeof p.title !== "string" || p.title === "" || typeof p.detail !== "string") return null;
  let action: ProblemAction | undefined;
  const a = p.action as Record<string, unknown> | undefined;
  if (a && typeof a === "object" && ACTIONS.has(a.kind as string)) {
    if (a.kind === "retry") action = { kind: "retry" };
    else if (typeof a.value === "string" && a.value !== "") {
      // A page is only ever an https link: a server's answer never opens anything else.
      action = a.kind === "copy_command" ? { kind: "copy_command", value: a.value } : typeof a.label === "string" && /^https:\/\//.test(a.value) ? { kind: "open_url", value: a.value, label: a.label } : undefined;
    }
  }
  return { code: p.code, kind: "tool", title: p.title, detail: p.detail, ...(action ? { action } : {}), at: typeof p.at === "string" ? p.at : "" };
}
