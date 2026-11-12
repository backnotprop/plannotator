export function isVSCodePanel(): boolean {
  return typeof window !== 'undefined' && (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE === true;
}
