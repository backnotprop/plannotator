/**
 * The window's history as a stack on a phone (history.ts): a screen opened
 * from the list goes back to it with the browser's Back, so the Back button
 * and the iOS swipe agree and neither leaves the thread one Forward away from
 * being reopened by a second Back. The failures this catches: Back pushing
 * the list as a new entry (the swipe back then reopens the thread just left),
 * and a double press going back twice, out of the Inbox, because the entry
 * changes only once the traversal lands.
 */
import { describe, expect, test } from 'bun:test';
import { backLanded, backTo, pushScreen, type HistoryLike } from './history';

/** A history whose Back lands only when `land()` is called, as a browser's traversal does a task later. */
function fakeHistory(): HistoryLike & { entries: { state: unknown; url: string }[]; index: number; backs: number; land: () => void } {
  const h = {
    entries: [{ state: null as unknown, url: '/' }],
    index: 0,
    backs: 0,
    queued: 0,
    get state() {
      return h.entries[h.index]!.state;
    },
    pushState(state: unknown, _title: string, url?: string | URL | null) {
      h.entries.splice(h.index + 1);
      h.entries.push({ state, url: String(url) });
      h.index += 1;
    },
    back() {
      h.backs += 1;
      h.queued += 1;
    },
    land() {
      h.index = Math.max(0, h.index - h.queued);
      h.queued = 0;
      backLanded();
    },
  };
  return h as never;
}

describe('the history stack', () => {
  test('a thread opened from the list goes back to it with Back, leaving no entry to reopen it', () => {
    const h = fakeHistory();
    pushScreen('#thread=msg_1', '', '#thread=msg_1', h);
    expect(h.entries.length).toBe(2);
    expect(backTo('', h)).toBe(true);
    h.land();
    expect(h.index).toBe(0);
    expect(h.entries[h.index]!.url).toBe('/');
  });

  test('a file goes back to its thread, then the thread to the list', () => {
    const h = fakeHistory();
    pushScreen('#thread=msg_1', '', '#thread=msg_1', h);
    pushScreen('#thread=msg_1&file=att_1', '#thread=msg_1', '#thread=msg_1&file=att_1', h);
    expect(backTo('#thread=msg_1', h)).toBe(true);
    h.land();
    expect(backTo('', h)).toBe(true);
    h.land();
    expect(h.index).toBe(0);
  });

  test('a second press before the first Back lands goes back once, not out of the Inbox', () => {
    const h = fakeHistory();
    pushScreen('#thread=msg_1', '', '#thread=msg_1', h);
    expect(backTo('', h)).toBe(true);
    // Still on the thread's entry: without the pending flag this would go back again.
    expect(backTo('', h)).toBe(true);
    expect(h.backs).toBe(1);
    h.land();
    expect(h.index).toBe(0);
  });

  test('a screen not opened from where it goes (a notification, a reload) is left to a new entry', () => {
    const h = fakeHistory();
    // Opened straight on the thread: no entry under it to go back to.
    expect(backTo('', h)).toBe(false);
    expect(h.index).toBe(0);
    // Opened from another project's list: going to the list at rest is a new entry.
    pushScreen('#project=prj_2&thread=msg_1', '#project=prj_2', '#project=prj_2&thread=msg_1', h);
    expect(backTo('', h)).toBe(false);
  });

  test('the screen already on top is not pushed again', () => {
    const h = fakeHistory();
    pushScreen('', '', '/', h);
    expect(h.entries.length).toBe(1);
  });
});
