import { isVSCodePanel } from '@plannotator/ui/utils/vscodePanel';

export function shouldPrintOnKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'target'>, blocked: boolean): boolean {
  if (event.key !== 'p' || !(event.metaKey || event.ctrlKey)) return false;
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
  if (blocked) return false;
  return !isVSCodePanel();
}
