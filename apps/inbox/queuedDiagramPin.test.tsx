// A real local outbox and linked door. The older receiver reads the legacy annotation field.
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TextEditor } from '../../packages/ui/components/diagram/NativeDiagramCard';
import { createInboxMachines } from '../../packages/server/inbox-machines';
import { InboxLinks } from '../../packages/server/inbox-links';
import { dispatchInboxFrame, inboxApi } from '../../packages/inbox/api';
import { rememberMachine, resetMachineRoutes } from '../../packages/inbox/inboxUrl';
import { watchCommentWrites } from '../../packages/inbox/commentSaves';

const peer = 'ibx_01K00000000000000000000001';
const message = 'msg_01K00000000000000000000002';
const file = 'att_01K00000000000000000000003';
const anchor = { v: 1, family: 'plannotator-diagram', kind: 'node', id: 'queue', label: 'Queue', point: { kind: 'panel', x: .5, y: .5 } };
const handlers = { onRecord() {}, onStatus() {} };

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

for (const target of ['message', 'attachment'] as const) {
  test.skipIf(typeof document === 'undefined')(`a queued ${target} pin keeps its draft and disables retry after its older owner wakes`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plannotator-held-pin-'));
    let online = false;
    const writes: Record<string, unknown>[] = [];
    async function oldDoor(request: Request) {
      if (!online) return new Response(null, { status: 503 });
      const route = new URL(request.url).pathname.replace('/api/inbox/device/', '');
      if (route === 'health') return Response.json({ inbox_id: peer, ok: true, machine_links: 1, version: '0.28.50' });
      if (route === 'threads') return Response.json({ sections: [], projects: [], cursor: 0 });
      if (route === 'events') return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('event: hello\ndata: {"cursor":0}\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (request.method === 'POST' && route.endsWith('annotations')) {
        const body = await request.json();
        writes.push(body);
        if (body.annotation) return Response.json({ annotation: body.annotation });
        return Response.json(target === 'message'
          ? { code: 'validation_error', field: 'annotation', error: 'annotation: an object.' }
          : { code: 'annotation_not_allowed', field: 'attachment_id', error: 'Download only.' }, { status: 422 });
      }
      return new Response(null, { status: 404 });
    }
    InboxLinks.open(dir).put({ id: peer, token: 'test', name: 'Mini', transport: { kind: 'tailnet', url: 'http://127.0.0.1:9019' }, device_id: null, linked_at: new Date().toISOString() });
    const machines = createInboxMachines({
      dataDir: dir, serverSession: 'test', computerName: () => 'Studio', holds: () => false,
      door: { openMachineOffer: () => ({ secret: '', code: '', expires_at: '' }), offerDevice: () => null, closeMachineOffer: () => null,
        revokeDevice() {}, tailnetAddress: () => null, tailnetError: () => null, publishTailnet: () => ({ ok: false, message: '' }), closeTailnetIfUnused() {} },
      readBody: req => req.json(), json: (body, status) => Response.json(body, { status }),
      timings: { backoffMinMs: 20, backoffMaxMs: 100 },
    });
    const states: string[] = [];
    machines.subscribe(frame => {
      if (frame.event !== 'outbox') return;
      states.push(frame.data.state);
      // The attachment window misses the owner's reply while reconnecting.
      if (target === 'message') dispatchInboxFrame({ name: 'outbox', data: JSON.stringify(frame.data), id: null }, handlers);
    });
    let localPosts = 0;
    const routeFetch = async (...[path, init]: Parameters<typeof fetch>) => {
      if (typeof path !== 'string' || !path.startsWith('/')) return oldDoor(new Request(path, init));
      if (init?.method === 'POST') localPosts++;
      const url = new URL(path, 'http://localhost');
      const request = new Request(url, init);
      const response = await machines.route(request, url, 'local');
      if (!response) throw new Error(`Unexpected window route ${url.pathname}`);
      return response;
    };
    const localFetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(routeFetch, { preconnect: fetch.preconnect }));
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    const draft = 'Show where retries stop.';
    const watch = watchCommentWrites();
    try {
      machines.start();
      await until(() => machines.machinesView().find(m => m.id === peer)?.state === 'offline');
      rememberMachine([message, file], peer);
      await act(async () => root.render(<TextEditor initial={draft} label="Comment on Queue" onCancel={() => {}} onDone={() => { throw new Error('unconfirmed pin'); }}
        onSubmit={async text => {
          const pin = { id: 'pin', type: 'COMMENT', originalText: 'Queue', text, diagramAnchor: anchor };
          if (target === 'message') await inboxApi.saveMessageAnnotation(message, pin);
          else await inboxApi.saveAnnotation(file, 'current', pin);
        }} />));
      const add = [...host.querySelectorAll('button')].find(button => button.textContent === 'Add comment')!;
      await act(async () => { add.click(); });
      expect(states).toContain('queued');
      expect(writes).toHaveLength(0);
      expect(add.disabled).toBe(true);
      // A queued pin must not hold the window's other Sends open while its owner sleeps.
      expect(await watch.settled()).toContainEqual({ kind: 'failed', on: target === 'message' ? message : file, id: 'pin', remove: false });
      await act(async () => {
        online = true;
        await until(() => states.includes('refused'));
        if (target === 'attachment') dispatchInboxFrame({ name: 'hello', data: '{}', id: null }, handlers);
      });
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('The other computer needs a newer Plannotator to pin this comment.');
      expect(host.querySelector('textarea')!.value).toBe(draft);
      expect(add.disabled).toBe(true);
      await act(async () => { host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
      expect(localPosts).toBe(1);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.diagram_annotation).toMatchObject({ text: draft });
      expect(writes[0]).not.toHaveProperty('annotation');
    } finally {
      watch.stop();
      act(() => root.unmount());
      host.remove();
      machines.stop();
      localFetch.mockRestore();
      resetMachineRoutes();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
