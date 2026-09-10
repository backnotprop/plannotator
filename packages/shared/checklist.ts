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
 */
const checklistPattern = /^[-*]\s*\[([ xX])\]\s+(.+)$/gm;

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
 * The line pattern and ordinal mapping match parseChecklist. Completion is
 * upgrade-only so a plan cannot lose a checked item during a state refresh.
 */
export function renderCompletedChecklist(content: string, items: ChecklistItem[]): string {
  let step = 0;
  return content.replace(checklistPattern, (line, marker: string) => {
    const item = items[step++];
    if (marker === " " && item?.completed) return line.replace("[ ]", "[x]");
    return line;
  });
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
