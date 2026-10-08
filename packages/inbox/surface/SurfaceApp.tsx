/**
 * The surface (PLAN step S1): what a native shell loads to show one
 * attachment with Plannotator's annotation tools, or one guided review.
 * Built by apps/inbox's `build:surface` into a single file with no network
 * (CSP `connect-src 'none'`); every byte arrives over the bridge
 * (./bridge.ts, adr/implementation/inbox-mobile.md section 5).
 *
 * The shell draws every bar and sheet; the surface draws only the document
 * and its marks, with Plannotator's viewers (Viewer and its toolstrip,
 * HtmlViewer with pins, DiagramViewer, the guide chain). The composer is the
 * shell's: the viewers hand their drafts over (`onHostDraft`) and the shell
 * answers with `commit_annotation` once the door saved the comment.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxAnnotationRecord, SurfaceOpenAttachment, SurfaceOpenGuide, SurfaceShellMessage } from '@plannotator/core/inbox-types';
import { ThemeProvider, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { configStore } from '@plannotator/ui/config';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { SurfaceDocument, type SurfaceDocumentHandle } from './SurfaceDocument';
import { SurfaceGuide } from './SurfaceGuide';
import { listenToShell, postToShell } from './bridge';

declare const __APP_VERSION__: string;

// Nothing persists and nothing is fetched: settings live in memory for this
// load, and the shell decides the theme. A phone reads diffs unified and
// wrapped (6.2).
const memory = new Map<string, string>();
configurePlannotatorUI({
  serverSync: () => {},
  webmcp: { enabled: false, namePrefix: 'plannotator.' },
  storageBackend: {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
    removeItem: (key) => void memory.delete(key),
  },
  skillCatalogTransport: async () => [],
  uploadTransport: {
    upload: async () => {
      throw new Error('Images cannot be added to a comment here.');
    },
  },
});
configStore.set('diffStyle', 'unified');
configStore.set('diffOverflow', 'wrap');

type Open = { kind: 'attachment'; message: SurfaceOpenAttachment; seq: number } | { kind: 'guide'; message: SurfaceOpenGuide; seq: number };

function upsert(records: readonly InboxAnnotationRecord[], record: InboxAnnotationRecord): InboxAnnotationRecord[] {
  const at = records.findIndex((r) => r.id === record.id);
  if (at < 0) return [...records, record];
  const next = records.slice();
  next[at] = record;
  return next;
}

function Surface() {
  const { setMode } = useTheme();
  const [open, setOpen] = useState<Open | null>(null);
  const [records, setRecords] = useState<InboxAnnotationRecord[]>([]);
  const [interact, setInteract] = useState(false);
  const [section, setSection] = useState<number | null>(null);
  const documentRef = useRef<SurfaceDocumentHandle>(null);
  const seq = useRef(0);

  const receive = useCallback(
    (message: SurfaceShellMessage) => {
      switch (message.type) {
        case 'open_attachment':
          seq.current += 1;
          setRecords(message.annotations);
          setInteract(false);
          setOpen({ kind: 'attachment', message, seq: seq.current });
          break;
        case 'open_guide':
          seq.current += 1;
          setSection(null);
          setOpen({ kind: 'guide', message, seq: seq.current });
          break;
        case 'open_section':
          setSection(message.section);
          break;
        case 'set_mode':
          setInteract(message.mode === 'interact');
          break;
        case 'step_pin':
          documentRef.current?.stepPin(message.direction);
          break;
        case 'set_appearance':
          setMode(message.theme);
          document.documentElement.style.setProperty('--sf-text-scale', String(message.text_scale));
          break;
        case 'commit_annotation':
          setRecords((current) => upsert(current, message.annotation));
          documentRef.current?.commit(message.annotation);
          break;
        case 'remove_annotation':
          setRecords((current) => current.filter((r) => r.id !== message.id));
          documentRef.current?.remove(message.id);
          break;
      }
    },
    [setMode],
  );

  useEffect(() => {
    const stop = listenToShell(receive);
    postToShell({ type: 'ready', bridge: 1, build: __APP_VERSION__ });
    return stop;
  }, [receive]);

  // Links in the content (markdown and text): the shell opens them in the
  // system browser. In-page `#` links stay with the viewer; a relative link
  // has nowhere to go without a file of its own, so it does nothing.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (!link || event.defaultPrevented) return;
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#')) return;
      event.preventDefault();
      if (/^(https?|mailto):/i.test(href)) postToShell({ type: 'link', href });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  if (open?.kind === 'attachment') {
    return <SurfaceDocument key={open.seq} ref={documentRef} open={open.message} records={records} interact={interact} />;
  }
  if (open?.kind === 'guide') {
    return (
      <SurfaceGuide
        key={open.seq}
        open={open.message}
        section={section}
        onSection={(next, sections) => {
          setSection(next);
          postToShell({ type: 'section', message_id: open.message.message_id, section: next, sections });
        }}
      />
    );
  }
  return null;
}

export function SurfaceApp() {
  return (
    <ThemeProvider defaultTheme="system">
      <div className="pn-surface">
        <Surface />
      </div>
    </ThemeProvider>
  );
}
