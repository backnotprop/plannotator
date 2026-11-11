/**
 * "Rules for your agents" (#2194; the owner approved the Settings place and the "Set the rules" dialog, 2026-11-11):
 * the person's own rules, ADDED after the Inbox reminder at session start (connection.ts `inboxReminderWithRules`).
 * The examples a tap adds, and the hand-off from the dialog's "Add your rules" to Settings → Prompts' editor.
 */

/** Rules a tap adds to the box, each on its own line. */
export const RULE_EXAMPLES = [
  'Only message me when you are blocked or done.',
  'Keep messages under 10 lines.',
  'Never send from reviewer sessions.',
  'Put the decision first.',
] as const;

/** The box's text with one example added on a line of its own (unchanged when it is already there). */
export function withRuleExample(text: string, example: string): string {
  if (text.includes(example)) return text;
  const kept = text.trimEnd();
  return kept === '' ? example : `${kept}\n${example}`;
}

/** The count shows this close to the room. */
export const RULES_COUNT_WITHIN = 400;

let editorWanted = false;

/** "Add your rules" in the dialog: the next Settings → Prompts opens the editor. */
export function wantRulesEditor(): void {
  editorWanted = true;
}

/** Whether the editor was asked for; asking spends it. */
export function takeRulesEditorWish(): boolean {
  const wanted = editorWanted;
  editorWanted = false;
  return wanted;
}

/** Whether the person has rules for any agent (the "Set the rules" dialog no longer holds then). */
export function rulesSet(rules: { shared: string | null; runtimes: Record<string, string | null> } | undefined): boolean {
  return !!rules && (rules.shared !== null || Object.values(rules.runtimes).some((own) => own !== null));
}
