export interface ChecklistItem {
  step: number;
  text: string;
  completed: boolean;
}

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

export function renderCompletedChecklist(content: string, items: ChecklistItem[]): string {
  const pattern = new RegExp(checklistPattern.source, `${checklistPattern.flags}d`);
  let result = "";
  let last = 0;
  let step = 0;
  for (const match of content.matchAll(pattern)) {
    if (match[2].trim().length === 0) continue;
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
