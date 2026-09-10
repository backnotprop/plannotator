/**
 * Checklist parsing and progress tracking utilities.
 *
 * Shared between Pi extension and OpenCode plugin for plan execution tracking.
 */

export interface ChecklistItem {
  /** 1-based step number, compatible with markCompletedSteps/extractDoneSteps. */
  step: number;
  text: string;
  completed: boolean;
}

/**
 * Parse standard markdown checkboxes from file content.
 *
 * Matches lines like:
 *   - [ ] Step description
 *   - [x] Completed step
 *   * [ ] Alternative bullet
 *
 * Whitespace inside the pattern is `[^\S\n]` (whitespace except newline), so a
 * match never crosses a line boundary: a whitespace-only checkbox line (`- [ ]`)
 * must not swallow the following line as its "text" — that would pair one
 * marker with another line's step and let renderCompletedChecklist flip the
 * blank placeholder instead of the real step's box.
 */
const checklistPattern = /^[-*][^\S\n]*\[([ xX])\][^\S\n]+(.+)$/gm;

export function parseChecklist(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  for (const match of content.matchAll(checklistPattern)) {
    const completed = match[1] !== " ";
    const text = match[2].trim();
    if (text.length > 0) {
      items.push({ step: items.length + 1, text, completed });
    }
  }
  return items;
}

/**
 * Render completed checklist items into Markdown without changing other text.
 *
 * The line pattern and ordinal mapping match parseChecklist exactly — including
 * its empty-text skip, so a checkbox line whose text is whitespace-only never
 * consumes an ordinal and cannot shift a later step's [x] onto the wrong line.
 * The marker is replaced at the match's own capture position (never by a
 * first-occurrence string search inside the matched chunk). Completion is
 * upgrade-only so a plan cannot lose a checked item during a state refresh.
 *
 * Callers hold a one-turn ordinal-desync window: `items` were parsed from the
 * plan as it stood at turn start, so if an agent edits the plan mid-turn
 * (inserting, removing, or reordering checkboxes) a step number reported this
 * turn can land on a neighboring box. The window is bounded by design:
 * writes are upgrade-only (a real checked box is never uncheckable) and the
 * checklist is re-parsed from disk on the next turn, which realigns ordinals.
 */
export function renderCompletedChecklist(content: string, items: ChecklistItem[]): string {
  const pattern = new RegExp(checklistPattern.source, `${checklistPattern.flags}d`);
  let result = "";
  let last = 0;
  let step = 0;
  for (const match of content.matchAll(pattern)) {
    if (match[2].trim().length === 0) continue; // mirror parseChecklist's empty-text skip
    const item = items[step++];
    if (match[1] === " " && item?.completed) {
      const [markerStart, markerEnd] = match.indices![1]!;
      result += content.slice(last, markerStart) + "x";
      last = markerEnd;
    }
  }
  return result + content.slice(last);
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: ChecklistItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}
