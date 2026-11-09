import { isVSCodePanel } from '@plannotator/ui/utils/vscodePanel';

/**
 * Cmd/Ctrl+P prints the plan or document. Not inside the VS Code panel, where
 * ⌘P is VS Code's Quick Open (the panel forwards it), and not from a text
 * field. `blocked`: a dialog or a decision owns the page.
 */
export function shouldPrintOnKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'target'>, blocked: boolean): boolean {
  if (event.key !== 'p' || !(event.metaKey || event.ctrlKey)) return false;
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
  if (blocked) return false;
  return !isVSCodePanel();
}
