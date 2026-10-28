/**
 * The question box: VS Code's own Quick Pick. Type a question or pick a
 * suggestion; a question asked before in this guide opens its answer instead
 * of asking again. The title says who answers and about what, its button the
 * model and effort (and changes them), and the last line what goes with the
 * question and where the answer opens.
 */

import * as vscode from "vscode";

export const ASK_SUGGESTIONS: ReadonlyArray<{ question: string; hint: string }> = [
  { question: "Why did this change?", hint: "the reasoning, with a before and after picture" },
  { question: "What could break?", hint: "callers, edge cases, what the tests miss" },
  { question: "How does this affect performance?", hint: "cost, load, what grows with the input" },
  { question: "Draw how this works", hint: "a diagram of the flow through this code" },
  { question: "Explain it like I'm new to this code", hint: "the background, step by step" },
];

export interface QuestionBoxInput {
  agentLabel: string;
  /** "Sonnet · Low". */
  modelEffort: string;
  /** "deliver.ts · lines 25–31", "chapter 2". */
  about: string;
  /** What goes with the question: "deliver.ts 25–31", "the file's diff", "Chapter 2", "the guide". */
  goesWith: string[];
  past: Array<{ id: string; question: string; sub: string; when: string }>;
  /** Pick another model or effort; the new "Model · Effort", or null when nothing changed. */
  changeModel(): Promise<string | null>;
  /** Text already typed (the chapter box). */
  value?: string;
}

export type QuestionChoice = { kind: "ask"; question: string } | { kind: "open"; answerId: string };

interface Item extends vscode.QuickPickItem {
  ask?: string;
  open?: string;
}

/** Items for what is typed so far: the typed question first, then suggestions and past questions. */
export function questionItems(input: Pick<QuestionBoxInput, "past" | "goesWith">, typed: string): Item[] {
  const items: Item[] = [];
  const text = typed.trim();
  if (text) items.push({ label: `$(sparkle) ${text}`, description: "ask this", ask: text, alwaysShow: true });
  items.push({ label: "Suggestions", kind: vscode.QuickPickItemKind.Separator });
  for (const s of ASK_SUGGESTIONS) items.push({ label: `$(sparkle) ${s.question}`, description: s.hint, ask: s.question });
  if (input.past.length) {
    items.push({ label: "Asked before in this guide", kind: vscode.QuickPickItemKind.Separator });
    for (const p of input.past) items.push({ label: `$(history) ${p.question}`, description: p.when ? `${p.sub} · ${p.when}` : p.sub, open: p.id });
  }
  items.push({ label: `Goes with it: ${input.goesWith.join(" · ")} · the answer opens beside the diff`, kind: vscode.QuickPickItemKind.Separator });
  return items;
}

/** Show the question box; undefined when it was dismissed. */
export async function pickQuestion(input: QuestionBoxInput): Promise<QuestionChoice | undefined> {
  let modelEffort = input.modelEffort;
  let value = input.value ?? "";
  for (;;) {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Ask ${input.agentLabel} about ${input.about}`;
    qp.placeholder = "Type a question, or pick one";
    qp.matchOnDescription = true;
    qp.ignoreFocusOut = false;
    qp.value = value;
    const modelButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("settings-gear"), tooltip: `${modelEffort} · change the model and effort` };
    qp.buttons = [modelButton];
    qp.items = questionItems(input, value);
    qp.onDidChangeValue((v) => {
      value = v;
      qp.items = questionItems(input, v);
    });
    const result = await new Promise<QuestionChoice | "model" | undefined>((resolve) => {
      let done = false;
      const finish = (r: QuestionChoice | "model" | undefined) => {
        if (done) return;
        done = true;
        resolve(r);
        qp.dispose();
      };
      qp.onDidTriggerButton((b) => {
        if (b === modelButton) finish("model");
      });
      qp.onDidAccept(() => {
        const item = qp.selectedItems[0] ?? qp.activeItems[0];
        if (item?.open) return finish({ kind: "open", answerId: item.open });
        if (item?.ask) return finish({ kind: "ask", question: item.ask });
        if (qp.value.trim()) return finish({ kind: "ask", question: qp.value.trim() });
      });
      qp.onDidHide(() => finish(undefined));
      qp.show();
    });
    if (result !== "model") return result;
    const changed = await input.changeModel();
    if (changed) modelEffort = changed;
  }
}
