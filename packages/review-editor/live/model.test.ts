import { describe, expect, test } from 'bun:test';
import type { InboxMessage } from '@plannotator/core/inbox-types';
import { anchorOfComment, deliveryWord, openThreadIds, placeThreads, stepThread, unsentComments } from './model';

const patch = ['@@ -1,6 +1,7 @@', ' export const RETRIES = 3;', ' ', ' export function charge(amount) {', '-  if (amount < 0) throw new Error("bad");', '+  if (amount < 0) throw new RangeError("amount");', '+  if (!Number.isInteger(amount)) throw new Error("cents");', '   return stripe.charge(amount);', ' }'].join('\n');
const files = [{ path: 'src/billing.ts', patch }];
const at = (min: number) => `2026-11-14T05:${String(min).padStart(2, '0')}:00.000Z`;
const msg = (over: Partial<InboxMessage>) => ({ id: 'm', project_id: 'p', thread_id: 't', reply_to: null, author: { kind: 'person' }, subject: null, body: 'x', created_at: at(0), resolved_at: null, idempotency_key: null, ...over }) as InboxMessage;

describe('a comment becomes an anchor the agent and a later round can read', () => {
  test('the new side carries the lines and their neighbours as they read', () => {
    expect(anchorOfComment({ filePath: 'src/billing.ts', lineStart: 4, lineEnd: 5, side: 'new' }, files)).toEqual({
      file: 'src/billing.ts',
      side: 'new',
      line_start: 4,
      line_end: 5,
      code: ['  if (amount < 0) throw new RangeError("amount");', '  if (!Number.isInteger(amount)) throw new Error("cents");'],
      context_before: ['export const RETRIES = 3;', '', 'export function charge(amount) {'],
      context_after: ['  return stripe.charge(amount);', '}'],
    });
  });

  test('a removed line reads from the old side; a whole-file comment has no lines', () => {
    expect(anchorOfComment({ filePath: 'src/billing.ts', lineStart: 4, lineEnd: 4, side: 'old' }, files).code).toEqual(['  if (amount < 0) throw new Error("bad");']);
    expect(anchorOfComment({ filePath: 'src/billing.ts', lineStart: 0, lineEnd: 0, side: 'new', scope: 'file' }, files)).toMatchObject({ line_start: 0, line_end: 0, code: [] });
  });

  test('the anchor it makes is found again on the same diff', () => {
    const anchor = anchorOfComment({ filePath: 'src/billing.ts', lineStart: 5, lineEnd: 5, side: 'new' }, files);
    const [placed] = placeThreads([msg({ id: 'c', review_anchor: anchor })], files);
    expect(placed!.now).toEqual({ place: 'here', line_start: 5, line_end: 5 });
  });
});

describe('what the person sees about delivery', () => {
  test('a comment sent in a review reads its lead message\'s delivery, then Read once the agent answered', () => {
    const lead = msg({ id: 'lead', review_batch: { id: 'b', lead: true } });
    const sibling = msg({ id: 'c', review_batch: { id: 'b', lead: false }, review_anchor: anchorOfComment({ filePath: 'src/billing.ts', lineStart: 4, lineEnd: 4, side: 'new' }, files) });
    expect(deliveryWord(sibling, [sibling, lead])).toBe('Queued');
    const delivered = { ...lead, delivery: { state: 'delivered', host: 'pi', session: 's', at: at(1) } } as InboxMessage;
    expect(deliveryWord(sibling, [sibling, delivered])).toBe('Delivered');
    const answer = msg({ id: 'a', reply_to: 'c', author: { kind: 'agent', host: 'pi', session: 's', name: null } as never, created_at: at(2) });
    expect(deliveryWord(sibling, [sibling, delivered, answer])).toBe('Read');
    expect(deliveryWord(answer, [answer])).toBeNull();
  });
});

describe('next and previous open thread', () => {
  test('follow the file order and the lines, skip resolved ones, and wrap', () => {
    const anchor = (line: number) => anchorOfComment({ filePath: 'src/billing.ts', lineStart: line, lineEnd: line, side: 'new' }, files);
    const placed = placeThreads([msg({ id: 'b', review_anchor: anchor(5) }), msg({ id: 'a', review_anchor: anchor(2) }), msg({ id: 'r', review_anchor: anchor(3), review_resolved: { at: at(3) } })], files);
    const order = openThreadIds(placed, ['src/billing.ts']);
    expect(order).toEqual(['a', 'b']);
    expect(stepThread(order, null, 1)).toBe('a');
    expect(stepThread(order, 'b', 1)).toBe('a');
    expect(stepThread(order, 'a', -1)).toBe('b');
  });
});

describe('comments not sent yet', () => {
  test('a comment that already went as a thread is not offered again, after a reload too; the others are', () => {
    const comment = { filePath: 'src/billing.ts', lineStart: 4, lineEnd: 4, side: 'new' as const, text: 'Use RangeError.' };
    const other = { ...comment, lineStart: 5, lineEnd: 5, text: 'Cents?' };
    const general = { ...comment, scope: 'general' as const, filePath: '', text: 'Overall fine.' };
    const placed = placeThreads([msg({ id: 'c', body: 'Use RangeError.', review_anchor: anchorOfComment(comment, files) })], files);
    expect(unsentComments([comment, other, general], placed)).toEqual([other]);
  });
});

describe('a pull request thread on the diff', () => {
  test('sits on its last line, on the side the forge names; a file-level one has no line', async () => {
    const { prThreadPlace } = await import('./PRThreadCard');
    const base = { id: 't', isResolved: false, isOutdated: false, path: 'src/a.ts', comments: [] };
    expect(prThreadPlace({ ...base, line: 12, startLine: 10, diffSide: 'RIGHT' })).toEqual({ line: 12, side: 'new' });
    expect(prThreadPlace({ ...base, line: 4, startLine: null, diffSide: 'LEFT' })).toEqual({ line: 4, side: 'old' });
    expect(prThreadPlace({ ...base, line: null, startLine: null, diffSide: null })).toBeNull();
  });
});

describe('a thread posted to the forge', () => {
  test('goes on its current lines with every reply, and a whole-file one as a file comment', async () => {
    const { forgeCommentsOf } = await import('./model');
    const anchor = anchorOfComment({ filePath: 'src/billing.ts', lineStart: 4, lineEnd: 5, side: 'new' }, files);
    const whole = anchorOfComment({ filePath: 'src/billing.ts', lineStart: 0, lineEnd: 0, side: 'new', scope: 'file' }, files);
    const placed = placeThreads(
      [
        msg({ id: 'c', body: 'Two checks here?', review_anchor: anchor }),
        msg({ id: 'a', reply_to: 'c', body: 'Merged into one.', author: { kind: 'agent', host: 'pi', session: 's', name: null } as never, created_at: at(1) }),
        msg({ id: 'f', body: 'Split this file.', review_anchor: whole }),
      ],
      files,
    );
    expect(forgeCommentsOf(placed)).toEqual({
      fileComments: [{ path: 'src/billing.ts', line: 5, side: 'RIGHT', start_line: 4, start_side: 'RIGHT', body: 'Two checks here?\n\n**Pi:** Merged into one.' }],
      fileLevelComments: [{ path: 'src/billing.ts', body: 'Split this file.' }],
    });
  });
});

describe('a review with many threads', () => {
  test('60 threads across 20 files are placed quickly; next and previous cross files in order; the open positions are there for the minimap', async () => {
    const { openThreadPositions } = await import('./model');
    const many = Array.from({ length: 20 }, (_, f) => ({
      path: `src/mod${String(f).padStart(2, '0')}.ts`,
      patch: ['@@ -1,40 +1,40 @@', ...Array.from({ length: 40 }, (_, n) => ` const v${f}_${n} = ${n};`)].join('\n'),
    }));
    const messages = many.flatMap((file, f) =>
      [5, 15, 25].map((line, k) => msg({ id: `t${f}_${k}`, review_anchor: anchorOfComment({ filePath: file.path, lineStart: line, lineEnd: line, side: 'new' }, many), ...(k === 2 && f % 2 ? { review_resolved: { at: at(1) } } : {}) })),
    );
    const started = performance.now();
    const placed = placeThreads(messages, many);
    expect(performance.now() - started).toBeLessThan(250);
    expect(placed.every((p) => p.now.place === 'here')).toBe(true);
    const order = openThreadIds(placed, many.map((f) => f.path));
    expect(order.length).toBe(50);
    expect(stepThread(order, 't0_2', 1)).toBe('t1_0');
    expect(stepThread(order, 't1_0', -1)).toBe('t0_2');
    expect(stepThread(order, order.at(-1)!, 1)).toBe('t0_0');
    const positions = openThreadPositions(placed);
    expect(positions.length).toBe(50);
    expect(positions[0]).toEqual({ id: 't0_0', file: 'src/mod00.ts', line: 5, side: 'new', changed: false });
  });
});

describe('the ended review', () => {
  test('Open it again names the thread in the address the Inbox acts on once', async () => {
    const { reopenUrl } = await import('./LiveEndedBar');
    expect(reopenUrl('http://localhost:49606/#thread=msg_01ABC')).toBe('http://localhost:49606/?open-review=msg_01ABC#thread=msg_01ABC');
  });
});
