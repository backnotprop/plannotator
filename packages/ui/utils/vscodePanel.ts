/**
 * There the panel forwards keys to VS Code, so a page key that shadows a VS Code window key (⌘P
 * is Quick Open there, not Print) should step aside.
 */
export function isVSCodePanel(): boolean {
  return typeof window !== 'undefined' && (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE === true;
}
