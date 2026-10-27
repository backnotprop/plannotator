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
import { backBy, backLanded, backTo, pushScreen, settleLanding, whileWritingRoute, type HistoryLike } from './history';

/** A history whose Back lands only when `land()` is called, as a browser's traversal does a task later. */
function fakeHistory(): HistoryLike & { entries: { state: unknown; url: string }[]; index: number; backs: number; land: () => void; withoutGo: () => void } {
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
    get length() {
      return h.entries.length;
    },
    back() {
      h.backs += 1;
      h.queued += 1;
    },
    go(delta: number) {
      h.backs += 1;
      h.queued += -delta;
    },
    withoutGo() {
      (h as { go?: unknown }).go = undefined;
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

test('with a comparison that ignores the view, a Back finds the entry it was opened from after the view changed on screen', async () => {
  const { sameScreenAnyView } = await import('./fileView');
  const h = fakeHistory();
  const page = '#thread=msg_1&file=att_1&view=side';
  pushScreen('#thread=msg_1&file=att_1&linked=B.html&view=side', page, '/x', h);
  // The default comparison: the page now named in the full-screen view is another hash, so no Back.
  expect(backTo('#thread=msg_1&file=att_1&view=full', h)).toBe(false);
  expect(h.backs).toBe(0);
  // Ignoring the view: the browser's Back, once.
  expect(backTo('#thread=msg_1&file=att_1&view=full', h, sameScreenAnyView)).toBe(true);
  expect(h.backs).toBe(1);
  h.land();
  expect(h.index).toBe(0);
  // Another page is still another screen.
  pushScreen('#thread=msg_1&file=att_1&linked=B.html&view=side', page, '/x', h);
  expect(backTo('#thread=msg_1&file=att_2&view=side', h, sameScreenAnyView)).toBe(false);
});

describe("full screen's way back (backBy, fullScreenOrigin.ts)", () => {
  /** The list, the thread, a file beside it, then `depth` entries of a full screen entered from there. */
  function besideThenFull(depth: number) {
    const h = fakeHistory();
    pushScreen('#thread=t', '', '#thread=t', h);
    pushScreen('#thread=t&file=a&view=side', '#thread=t', '/side', h);
    for (let i = 0; i < depth; i++) pushScreen(`#thread=t&file=b&view=full&n=${i}`, 'prev', `/full${i}`, h, { ibFullDepth: i + 1 });
    return h;
  }

  test('goes back exactly that many entries, onto the file beside the thread, in one traversal', () => {
    const h = besideThenFull(3);
    expect(backBy(3, h)).toBe(true);
    h.land();
    expect(h.entries[h.index]!.url).toBe('/side');
    expect(h.backs).toBe(1);
  });

  test('never goes back past the first entry: nothing is done and the caller writes the route instead', () => {
    const h = besideThenFull(1);
    // Four entries: four steps or more would leave the history.
    expect(backBy(h.entries.length, h)).toBe(false);
    expect(backBy(h.entries.length + 2, h)).toBe(false);
    expect(backBy(0, h)).toBe(false);
    expect(backBy(1.5, h)).toBe(false);
    expect(h.backs).toBe(0);
    // A history with no go: one step is still a Back, more is not tried.
    const single = besideThenFull(2);
    single.withoutGo();
    expect(backBy(2, single)).toBe(false);
    expect(backBy(1, single)).toBe(true);
    single.land();
    expect(single.backs).toBe(1);
  });

  test('a second press while the first is on its way goes back once, and the first Back keeps what it asked for', () => {
    const h = besideThenFull(2);
    const ran: string[] = [];
    expect(backBy(2, h, () => ran.push('first'))).toBe(true);
    expect(backBy(2, h, () => ran.push('second'))).toBe(true);
    expect(backTo('#thread=t', h, undefined, () => ran.push('third'))).toBe(true);
    expect(h.backs).toBe(1);
    h.land();
    settleLanding();
    expect(ran).toEqual(['first']);
    expect(h.entries[h.index]!.url).toBe('/side');
    // It ran once: a later hashchange runs nothing.
    settleLanding();
    expect(ran).toEqual(['first']);
  });

  test("the window's own route write before the Back lands is not its landing", () => {
    const h = besideThenFull(1);
    const ran: string[] = [];
    expect(backBy(1, h, () => ran.push('landed'))).toBe(true);
    // A route write (its own hashchange) while the Back is on its way.
    whileWritingRoute(() => settleLanding());
    expect(ran).toEqual([]);
    h.land();
    settleLanding();
    expect(ran).toEqual(['landed']);
  });
});
