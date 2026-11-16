/**
 * The routine editor saves by itself and says so (approval "inbox-routine-editor-autosave"), against a stand-in Inbox.
 * Each loss test is one way typed work used to be lost (the approval's FACTS.md): the page going with the cursor in a
 * field, a half-made new one, typing while a new one is being made, a failed write, an emptied name, leaving with the
 * field focused, and a new one that opened again after it was closed. On main several of them fail first at the save
 * on the typing pause, which main did not have; at this code each also pins its own rule (the same box and focus, no
 * reopen, one create). Then: an on routine's typed words wait for the field to be left (its next run reads them), the
 * header's status, the foot's Turn on and Run once now (each saves first, and is not taken when the save failed), a
 * refusal, Delete while it is being made, a saved one's edits kept through a reload (and forgotten once they no longer
 * apply), and Turn off taken at once. Timers are real: the waits
 * are a little over the 600 ms pause and the 1 s first retry. What regresses: words lost, a status that lies, a half
 * prompt saved to an on routine, the filled button back on Run, or a run or turn on with text that did not save.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { ScheduledPage } = (hasDom ? await import('./ScheduledPage') : {}) as typeof import('./ScheduledPage');
const { putScheduled, resetScheduledForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const PAUSE = 700;
const realFetch = globalThis.fetch;
let root: Root | null = null;
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  sessionStorage.clear();
});

type Call = { method: string; path: string; body: Record<string, unknown> | null; keepalive: boolean };

/**
 * The scheduled routes over rows kept here. `hold`: a POST to that path waits for `release` (which lets every held one
 * go). `fail`: that many writes to a routine fail with no answer. `refuse`: writes to a routine answer that 4xx.
 */
function inbox(start: InboxScheduledRow[], options: { hold?: string; fail?: number; refuse?: { status: number; code: string; error: string } } = {}) {
  const rows = new Map(start.map((row) => [row.id, row]));
  const calls: Call[] = [];
  const held: (() => void)[] = [];
  let fail = options.fail ?? 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const put = (id: string, change: Partial<InboxScheduledRow>) => {
    const row = { ...rows.get(id)!, ...change, updated_at: new Date(Date.now() + calls.length).toISOString() };
    rows.set(id, row);
    return json({ scheduled: row });
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body, keepalive: init?.keepalive === true });
    if (method === 'POST' && path === options.hold) await new Promise<void>((resolve) => held.push(resolve));
    if (path === '/api/inbox/scheduled') {
      if (method === 'GET') return json({ scheduled: [...rows.values()], launch_on: true });
      const row = scheduledRow('sch_made', { ...(body as Partial<InboxScheduledRow>), state: body?.enabled ? 'on' : 'off', enabled: body?.enabled === true });
      rows.set(row.id, row);
      return json({ scheduled: row }, 201);
    }
    if (path === '/api/inbox/scheduled/preview') return json({ ok: true, schedule_words: 'Every day at 9:00 AM', tz_short: 'EST', next_run: '2026-11-16T14:00:00.000Z' });
    const [, id, action] = /^\/api\/inbox\/scheduled\/([^/]+)(?:\/(\w+))?$/.exec(path) ?? [];
    if (!id || !rows.has(id)) return json({ code: 'not_found', error: 'No route.' }, 404);
    if (method === 'GET') return json({ scheduled: rows.get(id), runs: [] });
    if (method === 'POST' && action === undefined && fail > 0) {
      fail--;
      throw new TypeError('Failed to fetch');
    }
    if (method === 'POST' && action === undefined && options.refuse) return json({ code: options.refuse.code, error: options.refuse.error }, options.refuse.status);
    if (action === undefined) return put(id, body as Partial<InboxScheduledRow>);
    if (action === 'on' || action === 'off') return put(id, { state: action, enabled: action === 'on' });
    if (action === 'run') return put(id, { state: 'running', running_since: new Date().toISOString() });
    if (action === 'delete') {
      rows.delete(id);
      return json({ deleted: true });
    }
    return json({ code: 'not_found', error: 'No route.' }, 404);
  }) as typeof fetch;
  return { calls, rows, release: () => held.splice(0).forEach((go) => go()), fail: (n: number) => void (fail = n) };
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}
const wait = (ms: number) => act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));

function page(openId: string | null, rows: InboxScheduledRow[]) {
  resetScheduledForTests(rows, true);
  const opened: (string | null)[] = [];
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const draw = (id: string | null) =>
    act(() =>
      root!.render(
        <SidebarProvider>
          <ScheduledPage openId={id} switch="on" rows={[]} phone={false} stacked={false} onOpen={(next) => void opened.push(next)} onOpenThread={() => {}} onSettings={() => {}} />
        </SidebarProvider>,
      ),
    );
  draw(openId);
  return { host, opened, draw };
}

const nameBox = () => document.querySelector<HTMLInputElement>('[data-scheduled-editor] input[aria-label="Name"]')!;
const promptBox = () => document.querySelector<HTMLTextAreaElement>('[data-scheduled-editor] textarea[aria-label="Prompt"]')!;
const status = () => document.querySelector('[data-scheduled-status]');
const said = () => document.querySelector('[data-scheduled-status-said]')?.textContent ?? '';
const footLine = () => document.querySelector('[data-scheduled-foot-line]')?.textContent ?? '';
const writes = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** On, as most are: its typed name and prompt wait for the field to be left. */
const digest = () => scheduledRow('sch_digest', { name: 'Morning PR digest', prompt: 'Summarize the open pull requests.' });
/** Off: its typed words save on the typing pause. */
const draft = () => scheduledRow('sch_digest', { name: 'Morning PR digest', prompt: 'Summarize the open pull requests.', state: 'off', enabled: false });

test.skipIf(!hasDom)('the page going with the cursor in the prompt sends the words with keepalive, inside the typing pause', async () => {
  const server = inbox([digest()]);
  page('sch_digest', [digest()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests and the failing checks.');
  expect(status()?.textContent).toBe('Not saved yet');
  // A tab closes with visibilitychange then pagehide: one write, not two.
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
  // @ts-expect-error back to the document's own
  delete document.visibilityState;
  await settle();
  const sent = writes(server.calls, '/api/inbox/scheduled/sch_digest');
  expect(sent.map((c) => [c.body?.prompt, c.keepalive])).toEqual([['Summarize the open pull requests and the failing checks.', true]]);
  expect(status()?.textContent).toBe('Saved');
});

test.skipIf(!hasDom)('a new one with a name and a prompt is made as the page hides, with the key the tab keeps for it', async () => {
  const server = inbox([]);
  page('new', []);
  await settle();
  await typeInto(nameBox(), 'Docs link check');
  await typeInto(promptBox(), 'Check every link in the docs.');
  const kept = JSON.parse(sessionStorage.getItem('plannotator-routine-draft') ?? 'null') as { key: string } | null;
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle();
  // @ts-expect-error back to the document's own
  delete document.visibilityState;
  const creates = writes(server.calls, '/api/inbox/scheduled');
  expect(creates.length).toBe(1);
  expect(creates[0]).toMatchObject({ keepalive: true, body: { name: 'Docs link check', prompt: 'Check every link in the docs.', idempotency_key: kept?.key } });
  // Made: the tab's copy is forgotten.
  expect(sessionStorage.getItem('plannotator-routine-draft')).toBeNull();
});

test.skipIf(!hasDom)('a half-made new one comes back after the editor goes and comes back, and is forgotten once made or emptied', async () => {
  const server = inbox([]);
  const { draw } = page('new', []);
  await settle();
  await typeInto(promptBox(), 'Read this week’s feedback threads.');
  await wait(PAUSE);
  expect(writes(server.calls, '/api/inbox/scheduled')).toEqual([]);
  expect(status()?.textContent).toBe('Not saved yet');
  expect(footLine()).toBe('Saves by itself once it has a name and a prompt.');
  // Away and back (a refresh mounts it the same way): the words are there.
  draw(null);
  await settle();
  draw('new');
  await settle();
  expect(promptBox().value).toBe('Read this week’s feedback threads.');
  expect(nameBox().value).toBe('');
  // Emptied: forgotten.
  await typeInto(promptBox(), '');
  expect(sessionStorage.getItem('plannotator-routine-draft')).toBeNull();
  await typeInto(promptBox(), 'Read this week’s feedback threads.');
  await typeInto(nameBox(), 'Feedback digest');
  await wait(PAUSE);
  expect(writes(server.calls, '/api/inbox/scheduled').length).toBe(1);
  expect(sessionStorage.getItem('plannotator-routine-draft')).toBeNull();
  draw(null);
  await settle();
  draw('new');
  await settle();
  expect(promptBox().value).toBe('');
});

test.skipIf(!hasDom)('words typed while a new one is being made stay, with the cursor, when it takes its id', async () => {
  const server = inbox([], { hold: '/api/inbox/scheduled' });
  const { opened, draw } = page('new', []);
  await settle();
  await typeInto(nameBox(), 'Feedback digest');
  await typeInto(promptBox(), 'Read the feedback threads.');
  await wait(PAUSE);
  expect(writes(server.calls, '/api/inbox/scheduled').length).toBe(1);
  expect(status()?.textContent).toBe('Saving…');
  const box = promptBox();
  await typeInto(box, 'Read the feedback threads. Post a summary here.');
  server.release();
  await settle();
  expect(opened).toEqual(['sch_made']);
  // The window's address takes the new id: the same editor, the same box, focus and words kept.
  draw('sch_made');
  await settle();
  expect(promptBox()).toBe(box);
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe('Read the feedback threads. Post a summary here.');
  await wait(PAUSE);
  expect(writes(server.calls, '/api/inbox/scheduled').length).toBe(1);
  expect(server.rows.get('sch_made')?.prompt).toBe('Read the feedback threads. Post a summary here.');
  expect(status()?.textContent).toBe('Saved');
});

test.skipIf(!hasDom)('a write with no answer says so, keeps the words, and is tried again until it lands', async () => {
  const server = inbox([digest()], { fail: 1 });
  page('sch_digest', [digest()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests by owner.');
  await act(async () => promptBox().blur());
  await settle();
  expect(status()?.getAttribute('data-scheduled-status')).toBe('failed');
  expect(status()?.textContent).toBe("Couldn't save · retrying");
  expect(said()).toBe("Couldn't save the routine. Trying again.");
  expect(promptBox().value).toBe('Summarize the open pull requests by owner.');
  await wait(1200);
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest').length).toBe(2);
  expect(server.rows.get('sch_digest')?.prompt).toBe('Summarize the open pull requests by owner.');
  expect(status()?.textContent).toBe('Saved');
  expect(said()).toBe('');
});

test.skipIf(!hasDom)('an emptied name is not saved, the status says why, and the field stays empty while a change comes in', async () => {
  const server = inbox([draft()]);
  page('sch_digest', [draft()]);
  await settle();
  await typeInto(nameBox(), '');
  await wait(PAUSE);
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest')).toEqual([]);
  expect(status()?.textContent).toBe('Not saved · needs a name');
  expect(said()).toBe('Not saved: the routine needs a name.');
  // A change made elsewhere comes in: the name the person emptied is not put back.
  await act(async () => putScheduled({ ...server.rows.get('sch_digest')!, if_missed: 'skip', updated_at: '2026-11-16T12:00:00.000Z' }));
  await settle();
  expect(nameBox().value).toBe('');
  await typeInto(nameBox(), 'PR digest');
  await wait(PAUSE);
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest').map((c) => c.body)).toEqual([{ name: 'PR digest' }]);
  expect(status()?.textContent).toBe('Saved');
});

test.skipIf(!hasDom)('leaving while the prompt has focus (Back, a key, another row) saves what was typed', async () => {
  const server = inbox([digest()]);
  const { draw } = page('sch_digest', [digest()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests, oldest first.');
  // The editor goes with no blur first.
  draw(null);
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest').map((c) => c.body?.prompt)).toEqual(['Summarize the open pull requests, oldest first.']);
});

test.skipIf(!hasDom)('a new one closed while it is being made is made, and does not open again', async () => {
  const server = inbox([], { hold: '/api/inbox/scheduled' });
  const { opened, draw } = page('new', []);
  await settle();
  await typeInto(nameBox(), 'Feedback digest');
  await typeInto(promptBox(), 'Read the feedback threads.');
  await wait(PAUSE);
  draw(null);
  server.release();
  await settle();
  server.release();
  await settle();
  expect(server.rows.has('sch_made')).toBe(true);
  // The editor going sends nothing more: the same create is already on its way.
  expect(writes(server.calls, '/api/inbox/scheduled').length).toBe(1);
  expect(opened).toEqual([]);
});

test.skipIf(!hasDom)('the foot: Turn on is the filled step while off, the next run once on, and Run once now is quiet beside it', async () => {
  const off = scheduledRow('sch_off', { name: 'Feedback digest', state: 'off', enabled: false });
  const server = inbox([off]);
  page('sch_off', [off]);
  await settle();
  expect(status()?.textContent).toBe('Saved');
  expect(footLine()).toBe("Off, so it won't run on its own.");
  const turnOn = document.querySelector<HTMLButtonElement>('[data-scheduled-turn-on]')!;
  const once = document.querySelector<HTMLButtonElement>('[data-scheduled-run-now]')!;
  expect(turnOn.textContent).toBe('Turn on');
  expect(turnOn.classList.contains('ib-pri')).toBe(true);
  expect(once.textContent).toBe('Run once now');
  expect(once.classList.contains('ib-pri')).toBe(false);
  await act(async () => turnOn.click());
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_off/on').length).toBe(1);
  expect(footLine()).toMatch(/^On · next run .+ at \d{1,2}:\d{2}\s[AP]M$/);
  expect(document.querySelector('[data-scheduled-turn-on]')).toBeNull();
  expect(document.querySelectorAll('[data-scheduled-editor] .ib-pfoot .ib-pri').length).toBe(0);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-run-now]')!.click());
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_off/run').length).toBe(1);
});

test.skipIf(!hasDom)('a new one: Not saved yet and a dimmed Turn on until it has a name and a prompt; Turn on then makes it on', async () => {
  const server = inbox([]);
  page('new', []);
  await settle();
  expect(status()?.textContent).toBe('Not saved yet');
  expect(said()).toBe('');
  expect(document.querySelector<HTMLButtonElement>('[data-scheduled-turn-on]')?.disabled).toBe(true);
  expect(document.querySelector('[data-scheduled-run-now]')).toBeNull();
  await typeInto(nameBox(), 'Feedback digest');
  await typeInto(promptBox(), 'Read the feedback threads.');
  expect(document.querySelector<HTMLButtonElement>('[data-scheduled-turn-on]')?.disabled).toBe(false);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-turn-on]')!.click());
  await settle();
  const creates = writes(server.calls, '/api/inbox/scheduled');
  expect(creates.length).toBe(1);
  expect(creates[0]!.body).toMatchObject({ name: 'Feedback digest', enabled: true });
  expect(server.rows.get('sch_made')?.enabled).toBe(true);
});

test.skipIf(!hasDom)("an on routine's typed prompt is not saved on the typing pause, only when the field is left", async () => {
  const server = inbox([digest()]);
  page('sch_digest', [digest()]);
  await settle();
  await typeInto(promptBox(), 'Summarize');
  await wait(PAUSE + 300);
  // The clock could run it now: it would read the saved prompt, as nothing was sent.
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest')).toEqual([]);
  expect(status()?.getAttribute('data-scheduled-status')).toBe('held');
  expect(status()?.textContent).toBe('Not saved yet');
  expect(said()).toBe('');
  await typeInto(promptBox(), 'Summarize the open pull requests by team.');
  await act(async () => promptBox().blur());
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest').map((c) => c.body)).toEqual([{ prompt: 'Summarize the open pull requests by team.' }]);
  expect(status()?.textContent).toBe('Saved');
});

test.skipIf(!hasDom)("an on routine's schedule saves by itself, without the prompt being typed beside it", async () => {
  const server = inbox([digest()], { hold: '/api/inbox/scheduled/preview' });
  page('sch_digest', [digest()]);
  await settle();
  await typeInto(document.querySelector<HTMLInputElement>('[data-scheduled-editor] input[aria-label="Time"]')!, '10:30');
  await typeInto(promptBox(), 'Summarize');
  // The schedule's typing pause goes by while its preview has not answered, then the preview answers and it saves.
  await wait(PAUSE + 300);
  server.release();
  await settle();
  // Neither save takes the half prompt to the routine its next run reads.
  const sent = writes(server.calls, '/api/inbox/scheduled/sch_digest').map((c) => c.body);
  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) expect(Object.keys(body ?? {})).toEqual(['schedule']);
  expect(server.rows.get('sch_digest')?.prompt).toBe('Summarize the open pull requests.');
  expect(status()?.textContent).toBe('Not saved yet');
  await act(async () => promptBox().blur());
  await settle();
  expect(server.rows.get('sch_digest')?.prompt).toBe('Summarize');
  expect(status()?.textContent).toBe('Saved');
});

test.skipIf(!hasDom)('a new one turned on: words typed while it is being made wait for the field to be left', async () => {
  const server = inbox([], { hold: '/api/inbox/scheduled' });
  const { draw } = page('new', []);
  await settle();
  await typeInto(nameBox(), 'Feedback digest');
  await typeInto(promptBox(), 'Read the feedback threads.');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-turn-on]')!.click());
  await settle();
  await typeInto(promptBox(), 'Read the feedback threads. Post');
  await wait(PAUSE);
  server.release();
  await settle();
  draw('sch_made');
  await settle();
  await wait(PAUSE);
  // Made on: it can run now, so the half sentence is not sent on its own.
  expect(server.rows.get('sch_made')?.state).toBe('on');
  expect(writes(server.calls, '/api/inbox/scheduled/sch_made')).toEqual([]);
  expect(status()?.textContent).toBe('Not saved yet');
  await act(async () => promptBox().blur());
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_made').map((c) => c.body)).toEqual([{ prompt: 'Read the feedback threads. Post' }]);
});

test.skipIf(!hasDom)('Turn off stops an on routine at once, while a save is still on its way', async () => {
  const server = inbox([digest()], { hold: '/api/inbox/scheduled/sch_digest' });
  page('sch_digest', [digest()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests by team.');
  await act(async () => promptBox().blur());
  await settle();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-editor] [role="switch"]')!.click());
  await settle();
  // The save has not answered: the routine is off already.
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest/off').length).toBe(1);
  expect(server.rows.get('sch_digest')?.state).toBe('off');
  server.release();
  await settle();
  expect(server.rows.get('sch_digest')?.prompt).toBe('Summarize the open pull requests by team.');
});

test.skipIf(!hasDom)('Run once now saves what waits first, then runs it', async () => {
  const server = inbox([draft()]);
  page('sch_digest', [draft()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests, newest first.');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-run-now]')!.click());
  await settle();
  const order = server.calls.filter((c) => c.method === 'POST' && !c.path.endsWith('/preview')).map((c) => c.path);
  expect(order).toEqual(['/api/inbox/scheduled/sch_digest', '/api/inbox/scheduled/sch_digest/run']);
  expect(server.calls.find((c) => c.path === '/api/inbox/scheduled/sch_digest' && c.method === 'POST')?.body?.prompt).toBe('Summarize the open pull requests, newest first.');
});

test.skipIf(!hasDom)('Run once now and Turn on are not taken when the last change did not save, and say so', async () => {
  const server = inbox([draft()], { fail: 99 });
  page('sch_digest', [draft()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests by owner.');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-run-now]')!.click());
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest/run')).toEqual([]);
  expect(document.querySelector('[data-scheduled-editor] [role="alert"]')?.textContent).toBe("Not run: your last change isn't saved yet.");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-turn-on]')!.click());
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest/on')).toEqual([]);
  expect(document.querySelector('[data-scheduled-editor] [role="alert"]')?.textContent).toBe("Not turned on: your last change isn't saved yet.");
  expect(promptBox().value).toBe('Summarize the open pull requests by owner.');
});

test.skipIf(!hasDom)('after Run once now on an off routine, it is still off and Turn on turns it on', async () => {
  const server = inbox([draft()]);
  page('sch_digest', [draft()]);
  await settle();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-run-now]')!.click());
  await settle();
  expect(server.rows.get('sch_digest')?.state).toBe('running');
  expect(document.querySelector('[data-scheduled-editor] [role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  expect(footLine()).toBe("Off, so it won't run on its own.");
  expect(document.querySelector('[data-scheduled-stop]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-turn-on]')!.click());
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest/on').length).toBe(1);
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest/off')).toEqual([]);
});

test.skipIf(!hasDom)('a refused write is said in the alert line and not tried again until the next edit', async () => {
  const server = inbox([draft()], { refuse: { status: 404, code: 'routine_not_found', error: 'No routine sch_digest.' } });
  page('sch_digest', [draft()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests.\nSkip drafts.');
  await act(async () => promptBox().blur());
  await settle();
  expect(status()?.textContent).toBe("Couldn't save");
  expect(document.querySelector('[data-scheduled-editor] [role="alert"]')?.textContent).toBe('No routine sch_digest.');
  await wait(1200);
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest').length).toBe(1);
  expect(promptBox().value).toBe('Summarize the open pull requests.\nSkip drafts.');
});

test.skipIf(!hasDom)('Delete on a new one while it is being made deletes what was made', async () => {
  const server = inbox([], { hold: '/api/inbox/scheduled' });
  page('new', []);
  await settle();
  await typeInto(nameBox(), 'Feedback digest');
  await typeInto(promptBox(), 'Read the feedback threads.');
  await wait(PAUSE);
  expect(writes(server.calls, '/api/inbox/scheduled').length).toBe(1);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-scheduled-editor] button[aria-label="More"]')!.click());
  await settle();
  await act(async () => [...document.querySelectorAll<HTMLElement>('.ib-pmi')].find((item) => item.textContent === 'Delete')!.click());
  server.release();
  await settle();
  expect(writes(server.calls, '/api/inbox/scheduled/sch_made/delete').length).toBe(1);
  expect(server.rows.has('sch_made')).toBe(false);
  expect(document.querySelector('[data-scheduled-row="sch_made"]')).toBeNull();
});

test.skipIf(!hasDom)("a saved routine's words that did not save come back after a reload", async () => {
  const server = inbox([digest()], { fail: 99 });
  const { draw } = page('sch_digest', [digest()]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests and who is waiting on whom.');
  await act(async () => promptBox().blur());
  await settle();
  expect(status()?.textContent).toBe("Couldn't save · retrying");
  // The page goes (an Inbox that updated asks for a reload), and comes back.
  draw(null);
  await settle();
  server.fail(0);
  draw('sch_digest');
  await settle();
  expect(promptBox().value).toBe('Summarize the open pull requests and who is waiting on whom.');
  await act(async () => {
    promptBox().focus();
    promptBox().blur();
  });
  await settle();
  expect(server.rows.get('sch_digest')?.prompt).toBe('Summarize the open pull requests and who is waiting on whom.');
  expect(sessionStorage.getItem('plannotator-routine-edits:sch_digest')).toBeNull();
});

test.skipIf(!hasDom)("a kept edit over a field changed elsewhere since is forgotten on open, and never comes back", async () => {
  sessionStorage.setItem('plannotator-routine-edits:sch_digest', JSON.stringify({ fields: { prompt: 'An old edit.' }, was: { prompt: 'Summarize the pull requests.' } }));
  const server = inbox([digest()]);
  const { draw } = page('sch_digest', [digest()]);
  await settle();
  expect(promptBox().value).toBe('Summarize the open pull requests.');
  expect(sessionStorage.getItem('plannotator-routine-edits:sch_digest')).toBeNull();
  // The prompt goes back to what it was when the edit was kept, then the page reloads: the old edit stays gone.
  draw(null);
  await settle();
  const back = { ...server.rows.get('sch_digest')!, prompt: 'Summarize the pull requests.', updated_at: '2026-11-16T13:00:00.000Z' };
  server.rows.set('sch_digest', back);
  await act(async () => putScheduled(back));
  draw('sch_digest');
  await settle();
  expect(promptBox().value).toBe('Summarize the pull requests.');
  expect(writes(server.calls, '/api/inbox/scheduled/sch_digest')).toEqual([]);
});
