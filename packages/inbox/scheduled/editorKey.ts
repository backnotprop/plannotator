/**
 * The open editor's React key. A new routine keeps its editor when it is made and its address turns from
 * `#routine=new` to its id: no remount, so the words typed while it was being made, and the cursor, stay. Every other
 * open (another routine, New routine again) is a fresh editor.
 */
import { useRef } from 'react';

export function useEditorKey(openId: string | null): { key: string | null; created: (id: string) => void } {
  const lane = useRef({ open: null as string | null, made: null as string | null, n: 0 });
  const now = lane.current;
  if (openId !== now.open) {
    if (openId === 'new') now.n++;
    if (openId !== now.made) now.made = null;
    now.open = openId;
  }
  const key = openId === null ? null : openId === 'new' || openId === now.made ? `new-${now.n}` : openId;
  return { key, created: (id) => void (lane.current.made = id) };
}
