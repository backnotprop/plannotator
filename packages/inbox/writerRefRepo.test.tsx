import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing', root: '/work/billing', created_at: '2026-11-20T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const REPLY_ID = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';
const agent = (session: string) => ({ kind: 'agent' as const, host: 'claude-code', session, name: null });

function message(id: string, body: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return { id, project_id: PROJECT.id, thread_id: ROOT_ID, reply_to: id === ROOT_ID ? null : ROOT_ID, author: agent(`ses_${id.slice(-4)}`), subject: id === ROOT_ID ? 'Invoice export' : null, body, created_at: '2026-11-20T10:41:00.000Z', resolved_at: null, idempotency_key: null, ...extra };
}

const thread = (writerRepo: { display: string; host: string | null } | undefined): InboxThread => ({
  thread_id: ROOT_ID,
  project: { ...PROJECT, repo: { display: 'acme/billing', host: 'github.com' } },
  subject: 'Invoice export',
  thread_name: null,
  resolved_at: null,
  messages: [
    message(ROOT_ID, 'Started in #10.'),
    message(REPLY_ID, 'Fixed in #3951.', { from_project: { name: 'plannotator', root: '/work/plannotator', ...(writerRepo === undefined ? {} : { repo: writerRepo }) } }),
  ],
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function render(t: InboxThread): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={t} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

const hrefs = (el: HTMLElement) => [...el.querySelectorAll<HTMLAnchorElement>('a[href*="/issues/"]')].map((a) => a.getAttribute('href'));

test.skipIf(!hasDom)("a reply from another project's folder links its bare #N into the writer's repo; the thread's own message into the thread's", async () => {
  const el = await render(thread({ display: 'backnotprop/plannotator', host: 'github.com' }));
  expect(hrefs(el)).toContain('https://github.com/backnotprop/plannotator/issues/3951');
  expect(hrefs(el)).toContain('https://github.com/acme/billing/issues/10');
  expect(hrefs(el)).not.toContain('https://github.com/acme/billing/issues/3951');
});

test.skipIf(!hasDom)("a writer's repo not looked up yet draws the ref as text, never the thread's repo", async () => {
  const el = await render(thread(undefined));
  expect(hrefs(el)).toEqual(['https://github.com/acme/billing/issues/10']);
});
