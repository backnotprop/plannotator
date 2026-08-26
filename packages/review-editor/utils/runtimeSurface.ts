export function isVSCodeWebview(): boolean {
  return typeof window !== 'undefined' && (window as { __PLANNOTATOR_VSCODE?: boolean }).__PLANNOTATOR_VSCODE === true;
}
