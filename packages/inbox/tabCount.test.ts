/**
 * The tab count's rule (approval "inbox-tab-count"): threads with agent
 * messages the person has not looked at, never the waiting-on-you count, and
 * archived threads only when they came back. The window's wiring (title and
 * favicon over a real Inbox) is proved by tabCountWindow.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';
import { drawTabIcon, inboxTabCount, setAppBadge, tabBadgeLabel, tabIconSvg, tabTitle } from './tabCount';

let next = 0;
function row(over: Partial<InboxListRow> & { section: InboxSectionId }): InboxListRow {
  next += 1;
  return {
    thread_id: `msg_${next}`,
    project_id: 'prj_a',
    project: { id: 'prj_a', name: 'a' },
    subject: 's',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-20T10:00:00.000Z',
    last_at: '2026-10-20T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    thread_name: null,
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  } as InboxListRow;
}

function sections(...rows: InboxListRow[]): InboxListSection[] {
  const ids: InboxSectionId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'];
  return ids.map((id) => ({ id, label: id, threads: rows.filter((r) => r.section === id) }));
}

describe('inboxTabCount', () => {
  test('counts threads with unseen agent messages, once each, across projects', () => {
    const list = sections(
      row({ section: 'new', unseen: 3 }),
      row({ section: 'stopped', unseen: 1, project_id: 'prj_b', project: { id: 'prj_b', name: 'b' } }),
      row({ section: 'quiet', unseen: 0 }),
    );
    expect(inboxTabCount(list)).toBe(2);
  });

  test('a seen thread with an open question does not count', () => {
    const waiting = row({ section: 'waiting', unseen: 0, questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: 'Which?' } });
    expect(inboxTabCount(sections(waiting))).toBe(0);
  });

  test('an archived thread counts only when it came back', () => {
    const archived = row({ section: 'quiet', unseen: 2, resolved_at: '2026-10-20T11:00:00.000Z' });
    const cameBack = row({ section: 'new', unseen: 1, resolved_at: '2026-10-20T11:00:00.000Z', agent_after_archive: true, back_from_archive: true });
    expect(inboxTabCount(sections(archived))).toBe(0);
    expect(inboxTabCount(sections(archived, cameBack))).toBe(1);
  });
});

describe('the tab', () => {
  test('the badge says the number up to nine, then 9+', () => {
    expect([0, 1, 9, 10, 250].map(tabBadgeLabel)).toEqual(['', '1', '9', '9+', '9+']);
  });

  test('the title gains "(N) " and loses it at zero, never doubling it', () => {
    expect(tabTitle('Plannotator Inbox', 3)).toBe('(3) Plannotator Inbox');
    expect(tabTitle('(3) Plannotator Inbox', 12)).toBe('(12) Plannotator Inbox');
    expect(tabTitle('(12) Plannotator Inbox', 0)).toBe('Plannotator Inbox');
  });

  test('the SVG icon carries the plain icon and the label', () => {
    const svg = decodeURIComponent(tabIconSvg('data:image/png;base64,AAAA', 12).split(',')[1]);
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(svg).toContain('>9+</text>');
    expect(decodeURIComponent(tabIconSvg('data:image/png;base64,AAAA', 0))).not.toContain('<text');
  });

  test('a canvas without roundRect (Safari before 16, Firefox before 112) gives null, so the SVG is drawn instead', () => {
    const ctx = { drawImage() {}, beginPath() {}, fill() {}, stroke() {}, fillText() {} };
    const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,X' }) } as unknown as Document;
    expect(drawTabIcon({} as CanvasImageSource, 3, doc)).toBeNull();
    // With the whole API the PNG comes back.
    const full = { ...ctx, roundRect() {} };
    const fullDoc = { createElement: () => ({ width: 0, height: 0, getContext: () => full, toDataURL: () => 'data:image/png;base64,X' }) } as unknown as Document;
    expect(drawTabIcon({} as CanvasImageSource, 3, fullDoc)).toBe('data:image/png;base64,X');
  });

  test("the app's icon gets the count itself, and no badge at zero", () => {
    const calls: (number | 'clear')[] = [];
    const nav = { setAppBadge: async (n?: number) => void calls.push(n!), clearAppBadge: async () => void calls.push('clear') };
    setAppBadge(3, nav);
    // Past nine the number goes as it is: the system shortens it its own way.
    setAppBadge(12, nav);
    setAppBadge(0, nav);
    expect(calls).toEqual([3, 12, 'clear']);
  });

  test('a browser without the Badging API, or one that refuses, changes nothing and throws nothing', async () => {
    expect(() => setAppBadge(3, {} as Navigator)).not.toThrow();
    const refuses = { setAppBadge: () => Promise.reject(new DOMException('no', 'NotAllowedError')), clearAppBadge: () => { throw new Error('no'); } };
    expect(() => setAppBadge(3, refuses)).not.toThrow();
    expect(() => setAppBadge(0, refuses)).not.toThrow();
    // An unhandled rejection would fail this test on the next turn.
    await new Promise((done) => setTimeout(done, 0));
  });
});
