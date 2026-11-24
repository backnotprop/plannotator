import { expect, spyOn, test } from 'bun:test';
import { act, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { NativeDiagramBlockContext } from '@plannotator/ui/components/diagram/nativeDiagramEnabled';
import { INBOX_FILE_SOURCE, InboxFileSourceProvider } from '../fileSource';
import { InlineDiagrams } from './InlineDiagrams';

test.skipIf(typeof document === 'undefined')('an unavailable native chunk leaves the thread draft mounted and displays the source', async () => {
  const attachment: InboxAttachmentState = {
    id: 'diagram', name: 'worker.diagram.json', path: '/work/worker.diagram.json', kind: 'plannotator-diagram',
    message_id: 'sender', sent_sha256: 'a'.repeat(64), named_path: null, size: 40, sent_at: '', sent_mtime: '',
    changed_since_sent: false, unavailable: null, current: null,
  };
  const text = '{"title":"Worker","columns":[]}';
  const source = { ...INBOX_FILE_SOURCE, view: async () => ({ serverSession: '', attachment, version: attachment.sent_sha256!, text, html: null }) };
  let reject!: (e: Error) => void;
  const broken = lazy(() => new Promise<never>((_, fail) => { reject = fail; }));
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(<InboxFileSourceProvider source={source}>
      <textarea aria-label="Thread reply" />
      <NativeDiagramBlockContext.Provider value={broken}>
        <InlineDiagrams files={[attachment]} records={[]} readOnly onSaved={() => {}} />
      </NativeDiagramBlockContext.Provider>
    </InboxFileSourceProvider>));
    const reply = host.querySelector('textarea')!;
    reply.value = 'An unsent reply';
    await act(async () => reject(new Error('Chunk unavailable')));
    expect(host.querySelector('pre')?.textContent).toBe(text);
    expect(host.querySelector('button')?.textContent).toBe('Reload');
    expect(host.querySelector('textarea')).toBe(reply);
    expect(reply.value).toBe('An unsent reply');
  } finally {
    log.mockRestore();
    await act(async () => root.unmount());
    host.remove();
  }
});
