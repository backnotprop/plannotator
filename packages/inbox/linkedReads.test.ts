/**
 * The reads a linked machine's door serves this window for its own threads (mark `linked-reads`): each goes to that
 * machine through the forward once its list says the mark, and an older machine (no mark) is asked nothing new, so
 * the window shows what it showed before. Also the Tag filter's ids and a far steps line.
 */
import { afterEach, expect, test } from 'bun:test';
import { inboxApi } from './api';
import { dispatchInboxFrame } from './eventFrames';
import { rememberMachine, resetMachineRoutes, setSelfMachine } from './inboxUrl';
import { guideReviewImages } from './reviewImages';
import { searchPasses } from './search/searchMachines';
import { searchTagIds } from './search/searchTags';
import { tagsOnOwnRows } from './threadTags';
import { FAR_READS_AT_ONCE, farRead, machineServesReads, ownerSwitch, threadStepsRead } from './linkedReads';
import type { InboxListRow } from '@plannotator/core/inbox-types';

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const NEW = `ibx_01K${'0'.repeat(22)}N`;
const OLD = `ibx_01K${'0'.repeat(22)}D`;
const NEW_THREAD = 'msg_01KNEWTHREAD0000000000001';
const OLD_THREAD = 'msg_01KOLDTHREAD0000000000001';
const LOCAL_THREAD = 'msg_01KLOCALTHREAD00000000001';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetMachineRoutes();
});

function linked() {
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Studio' },
    { id: NEW, name: 'MacBook', marks: ['tags', 'linked-reads'], list_cursor: 3, state: 'online' },
    { id: OLD, name: 'Mini', marks: ['tags'], list_cursor: 5, state: 'online' },
  ]);
  rememberMachine([NEW_THREAD], NEW);
  rememberMachine([OLD_THREAD], OLD);
}

function stub(answer: unknown): string[] {
  const asked: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    asked.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  return asked;
}

test("a linked thread's steps are read on its machine; an older machine is not asked and reads as off", async () => {
  linked();
  const asked = stub({ serverSession: 's', on: true, steps: [{ id: 'stp_1', steps: [] }] });
  expect((await inboxApi.threadSteps(NEW_THREAD)).on).toBe(true);
  expect(asked).toEqual([`/api/inbox/m/${NEW}/threads/${NEW_THREAD}/steps`]);
  expect(await inboxApi.threadSteps(OLD_THREAD)).toEqual({ on: false, steps: [] });
  expect(asked).toHaveLength(1);
  await inboxApi.threadSteps(LOCAL_THREAD);
  expect(asked[1]).toBe(`/api/inbox/threads/${LOCAL_THREAD}/steps`);
});

test("a linked thread's steps follow that machine's Steps switch, never this computer's", async () => {
  linked();
  // Off here: this computer's threads read none, a linked machine's thread is still asked.
  expect(threadStepsRead(LOCAL_THREAD, { on: false })).toBe(false);
  expect(threadStepsRead(NEW_THREAD, { on: false })).toBe(true);
  expect(threadStepsRead(NEW_THREAD, undefined)).toBe(true);
  expect(threadStepsRead(LOCAL_THREAD, { on: true })).toBe(true);
  expect(threadStepsRead(LOCAL_THREAD, undefined)).toBeNull();
  // Asked, that machine's answer decides: off there reads as off.
  const asked = stub({ serverSession: 's', on: false, steps: [{ id: 'stp_1', steps: [] }] });
  expect((await inboxApi.threadSteps(NEW_THREAD)).on).toBe(false);
  expect(asked).toEqual([`/api/inbox/m/${NEW}/threads/${NEW_THREAD}/steps`]);
});

test('a switch on a linked machine\'s thread or message is that machine\'s; this computer\'s own is this one\'s', () => {
  linked();
  expect(ownerSwitch(NEW_THREAD, true, false)).toBe(false);
  expect(ownerSwitch(NEW_THREAD, false, true)).toBe(true);
  expect(ownerSwitch(LOCAL_THREAD, true, false)).toBe(true);
  expect(ownerSwitch(LOCAL_THREAD, false, true)).toBe(false);
});

test("a file a linked thread names is checked on its machine (its path there); an older one is not asked", async () => {
  linked();
  const asked = stub({ found: true, path: '/Users/ada/shop/src/a.ts', kind: 'code' });
  expect(await inboxApi.openInFileCheck({ thread: NEW_THREAD, message: NEW_THREAD }, 'src/a.ts')).toEqual({ found: true, path: '/Users/ada/shop/src/a.ts', kind: 'code' });
  expect(new URL(asked[0]!, 'http://x').pathname).toBe(`/api/inbox/m/${NEW}/open-in/file`);
  expect(await inboxApi.openInFileCheck({ thread: OLD_THREAD }, 'src/a.ts')).toEqual({ found: false });
  expect(asked).toHaveLength(1);
  await inboxApi.openInFileCheck({ thread: LOCAL_THREAD }, 'src/a.ts');
  expect(new URL(asked[1]!, 'http://x').pathname).toBe('/api/inbox/open-in/file');
});

test("a code span's hover text on a linked thread is read on its machine; an older one is not asked", async () => {
  linked();
  const asked = stub({ found: true, contents: 'x' });
  expect(await inboxApi.openInFileCode({ thread: NEW_THREAD, message: NEW_THREAD }, 'src/a.ts')).toEqual({ found: true, contents: 'x' });
  const url = new URL(asked[0]!, 'http://x');
  expect(url.pathname).toBe(`/api/inbox/m/${NEW}/open-in/file/code`);
  expect(Object.fromEntries(url.searchParams)).toEqual({ thread: NEW_THREAD, message: NEW_THREAD, path: 'src/a.ts' });
  expect(await inboxApi.openInFileCode({ thread: OLD_THREAD }, 'src/a.ts')).toEqual({ found: false });
  expect(asked).toHaveLength(1);
  // A PR page's scope is this computer's, as before.
  await inboxApi.openInFileCode({ repo: 'github.com/o/r', pull: 'p' }, 'src/a.ts');
  expect(new URL(asked[1]!, 'http://x').pathname).toBe('/api/inbox/open-in/file/code');
});

test("a linked guided review's image sides, pictures and package changes are read on its machine; an older one has none", async () => {
  linked();
  const images = guideReviewImages(NEW_THREAD)!;
  expect(images.markdownImageUrl('/api/review-markdown-image?doc=a.md&side=new&src=b.png&snapshot=x')).toBe(
    `/api/inbox/m/${NEW}/messages/${NEW_THREAD}/guide/review-markdown-image?doc=a.md&side=new&src=b.png&snapshot=${NEW_THREAD}`,
  );
  const asked = stub({});
  await images.fetchImpl('/api/review-image?path=a.png&side=old&snapshot=x');
  await images.fetchImpl('/api/package-changes?snapshot=x');
  expect(asked).toEqual([`/api/inbox/m/${NEW}/messages/${NEW_THREAD}/guide/review-image?path=a.png&side=old&snapshot=${NEW_THREAD}`, `/api/inbox/m/${NEW}/messages/${NEW_THREAD}/guide/package-changes?snapshot=${NEW_THREAD}`]);
  expect(guideReviewImages(OLD_THREAD)).toBeUndefined();
  expect(guideReviewImages(LOCAL_THREAD)!.markdownImageUrl('/api/review-markdown-image?doc=a.md&snapshot=x')).toBe(`/api/inbox/messages/${LOCAL_THREAD}/guide/review-markdown-image?doc=a.md&snapshot=${LOCAL_THREAD}`);
});

test("before a machine's list is read its marks are unknown: nothing new is asked of it", () => {
  setSelfMachine(SELF, [{ id: SELF, self: true, name: 'Studio' }, { id: NEW, name: 'MacBook', list_cursor: null, state: 'connecting' }]);
  expect(machineServesReads(NEW)).toBe(false);
  expect(machineServesReads(SELF)).toBe(true);
  expect(machineServesReads(null)).toBe(true);
});

test("another machine's steps line reads that thread's checklist again, as this Inbox's own does; its PR line still does not", () => {
  const records: unknown[] = [];
  const machines: unknown[] = [];
  const steps: string[] = [];
  const handlers = { onRecord: (event: unknown) => void records.push(event), onStatus: () => {}, onMachine: (frame: unknown) => void machines.push(frame), onSteps: (threadId: string) => void steps.push(threadId) };
  dispatchInboxFrame({ name: 'machine', id: null, data: JSON.stringify({ machine: NEW, seq: 7, live: true, record: { seq: 7, kind: 'steps', id: 'stp_1', thread_id: NEW_THREAD } }) }, handlers);
  dispatchInboxFrame({ name: 'machine', id: null, data: JSON.stringify({ machine: NEW, seq: 8, live: true, record: { seq: 8, kind: 'thread_pull', thread_id: NEW_THREAD } }) }, handlers);
  expect(steps).toEqual([NEW_THREAD]);
  // Never a record (a list or thread read) nor a machine line.
  expect(records).toEqual([]);
  expect(machines).toEqual([]);
});

test('a Tag filter searches every machine: both passes, with each machine\'s id of each picked tag', () => {
  setSelfMachine(SELF);
  expect(searchPasses({ project: null, tags: ['ini_A'] })).toBe('both');
  const tags = [
    { id: 'ini_A', name: 'Release', machines: { [SELF]: 'ini_A', [NEW]: 'ini_B' } },
    { id: 'ini_C', name: 'Docs', machines: { [NEW]: 'ini_C' } },
    { id: 'ini_D', name: 'Old' },
  ] as unknown as Parameters<typeof searchTagIds>[0];
  expect(searchTagIds(tags, ['ini_A', 'ini_C'])).toEqual(['ini_A', 'ini_B', 'ini_C']);
  expect(searchTagIds(tags, ['ini_D', 'ini_gone'])).toEqual(['ini_D', 'ini_gone']);
});

test("the Tag chip offers a linked machine's tags once its search takes the filter, never an older machine's", () => {
  const tags = [{ id: 'ini_A', name: 'Release' }, { id: 'ini_B', name: 'Docs' }, { id: 'ini_C', name: 'Old' }] as unknown as Parameters<typeof tagsOnOwnRows>[0];
  const rows = [
    { thread_id: 't1', tags: ['ini_A'] },
    { thread_id: 't2', machine: NEW, tags: ['ini_B'] },
    { thread_id: 't3', machine: OLD, tags: ['ini_C'] },
  ] as unknown as InboxListRow[];
  const tagsOf = (row: Pick<InboxListRow, 'tags'>) => row.tags ?? [];
  expect(tagsOnOwnRows(tags, rows, SELF, tagsOf).map((tag) => tag.id)).toEqual(['ini_A']);
  expect(tagsOnOwnRows(tags, rows, SELF, tagsOf, (machine) => machine === NEW).map((tag) => tag.id)).toEqual(['ini_A', 'ini_B']);
});

test("reads of linked machines' threads are held to a few at once; this computer's own are never queued behind them", async () => {
  linked();
  const started: string[] = [];
  const release: (() => void)[] = [];
  const read = (name: string) => () =>
    new Promise<string>((done) => {
      started.push(name);
      release.push(() => done(name));
    });
  const far = Array.from({ length: FAR_READS_AT_ONCE + 2 }, (_, i) => farRead(NEW_THREAD, read(`far-${i}`)));
  const own = farRead(LOCAL_THREAD, read('own'));
  await Promise.resolve();
  expect(started).toEqual([...Array.from({ length: FAR_READS_AT_ONCE }, (_, i) => `far-${i}`), 'own']);
  // One answers: the next one waiting starts.
  release.shift()!();
  await far[0];
  await Promise.resolve();
  expect(started).toContain(`far-${FAR_READS_AT_ONCE}`);
  // Every read answers in turn, so none is left waiting.
  for (let i = 0; i < 20 && release.length; i++) {
    while (release.length) release.shift()!();
    await new Promise((go) => setTimeout(go, 0));
  }
  expect(await Promise.all([...far, own])).toEqual([...Array.from({ length: FAR_READS_AT_ONCE + 2 }, (_, i) => `far-${i}`), 'own']);
});
