import { useCallback, useEffect, useRef, useState } from 'react';
import { browserTabPort, createTabHub, HEARTBEAT_MS, type TabHub, type TabRole } from './threadTabs';

const NONE: ReadonlySet<string> = new Set();

function newTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through.
  }
  return `t${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

/**
 * This tab's part in Thread tabs (threadTabs.ts): joins the tab channel while the capability is on, announces its
 * role (`aloneThread`: the thread it shows alone, else main), and keeps the anchored threads a main tab sees.
 * `onOpen`: a thread tab asked this (most recently used) main tab to open a link.
 */
export function useThreadTabs(enabled: boolean, aloneThread: string | null, onOpen: (route: string) => void): { anchored: ReadonlySet<string>; requestOpen: (route: string, unanswered: () => void) => void } {
  const [anchored, setAnchored] = useState<ReadonlySet<string>>(NONE);
  const hub = useRef<TabHub | null>(null);
  const role: TabRole = aloneThread ? { kind: 'thread', thread: aloneThread } : { kind: 'main' };
  const roleRef = useRef(role);
  roleRef.current = role;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!enabled) {
      setAnchored(NONE);
      return;
    }
    const channel = browserTabPort();
    if (!channel) return;
    const tab = newTabId();
    const made = createTabHub({ port: channel.port, tab, role: roleRef.current, onOpen: (route) => openRef.current(route) });
    hub.current = made;
    const read = () => setAnchored(made.anchored());
    const off = made.subscribe(read);
    const beat = setInterval(() => made.beat(), HEARTBEAT_MS);
    const used = () => made.used();
    window.addEventListener('focus', used);
    const leave = () => made.close();
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(beat);
      window.removeEventListener('focus', used);
      window.removeEventListener('pagehide', leave);
      off();
      made.close();
      channel.close();
      hub.current = null;
      setAnchored(NONE);
    };
  }, [enabled]);
  const roleKey = aloneThread ?? '';
  useEffect(() => {
    hub.current?.setRole(roleRef.current);
  }, [roleKey, enabled]);
  const requestOpen = useCallback((route: string, unanswered: () => void) => {
    if (hub.current) hub.current.requestOpen(route, unanswered);
    else unanswered();
  }, []);
  return { anchored, requestOpen };
}
