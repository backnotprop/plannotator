export const RULES_COUNT_WITHIN = 400;

let editorWanted = false;

export function wantRulesEditor(): void {
  editorWanted = true;
}

export function takeRulesEditorWish(): boolean {
  const wanted = editorWanted;
  editorWanted = false;
  return wanted;
}

export function rulesSet(rules: { shared: string | null; runtimes: Record<string, string | null> } | undefined): boolean {
  return !!rules && (rules.shared !== null || Object.values(rules.runtimes).some((own) => own !== null));
}
