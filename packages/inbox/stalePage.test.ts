/**
 * The stale page notice (stalePage.ts): a page older than the Inbox it talks to says so, and never otherwise.
 *
 * What would regress: a dev Inbox or a page with no build nagging on every load; an older Inbox (the version matrix
 * runs today's page on a 0.28.10 build) asking for a reload that changes nothing; a server restarted onto a newer
 * release under an open page going unnoticed until a reload; a dismissed notice never coming back; and a Reload
 * that goes ahead while something the person wrote is not saved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createStalePageChecker, flushBeforeReload, newerInbox, onPageReturn, registerReloadFlush } from './stalePage';

describe('newerInbox', () => {
  test('the same release is no notice', () => {
    expect(newerInbox('0.28.46', '0.28.46')).toBeNull();
    expect(newerInbox('0.28.46', 'v0.28.46')).toBeNull();
  });

  test('a newer release names itself, whichever part moved', () => {
    expect(newerInbox('0.28.46', '0.28.47')).toBe('0.28.47');
    expect(newerInbox('0.28.46', '0.29.0')).toBe('0.29.0');
    expect(newerInbox('0.28.46', '1.0.0')).toBe('1.0.0');
    // Compared as numbers, not text.
    expect(newerInbox('0.28.9', '0.28.10')).toBe('0.28.10');
  });

  test('an older Inbox never asks for a reload', () => {
    expect(newerInbox('0.28.46', '0.28.10')).toBeNull();
    expect(newerInbox('0.28.46', '0.27.99')).toBeNull();
  });

  test('a development build on either side is skipped', () => {
    // A source run says `dev`; CI's and a local compiled build say `0.0.0-dev`.
    expect(newerInbox('0.28.46', 'dev')).toBeNull();
    expect(newerInbox('0.28.46', '0.0.0-dev')).toBeNull();
    expect(newerInbox('0.28.46', '0.0.0')).toBeNull();
    expect(newerInbox('0.0.0', '0.28.46')).toBeNull();
    // A page with no build (a test, a bare bundle) and a pre-release.
    expect(newerInbox(null, '0.28.47')).toBeNull();
    expect(newerInbox('0.28.46', '0.28.47-rc.1')).toBeNull();
    expect(newerInbox('0.28.46', undefined)).toBeNull();
  });
});

/** A checker over an Inbox whose release the test sets, recording what the notice shows. */
function world(page: string | null, inbox: string) {
  const state = { inbox, reads: 0, fail: false, shown: [] as (string | null)[] };
  const checker = createStalePageChecker(
    page,
    async () => {
      state.reads += 1;
      if (state.fail) throw new Error('offline');
      return state.inbox;
    },
    (next) => state.shown.push(next),
  );
  const notice = () => state.shown.at(-1) ?? null;
  return { state, checker, notice };
}

describe('createStalePageChecker', () => {
  test('a reconnect after the Inbox restarted onto a newer release shows the notice', async () => {
    const { state, checker, notice } = world('0.28.46', '0.28.46');
    checker.saw('0.28.46');
    expect(notice()).toBeNull();
    // The Inbox updates and restarts; the event stream's hello asks again.
    state.inbox = '0.28.47';
    await checker.recheck();
    expect(notice()).toBe('0.28.47');
  });

  test('a dismissed notice comes back on the next check that still finds the page behind', async () => {
    const { checker, notice } = world('0.28.46', '0.28.47');
    checker.saw('0.28.47');
    checker.dismiss();
    expect(notice()).toBeNull();
    await checker.recheck();
    expect(notice()).toBe('0.28.47');
  });

  test('a failed read and an Inbox that does not say its version change nothing', async () => {
    const { state, checker, notice } = world('0.28.46', '0.28.47');
    checker.saw('0.28.47');
    state.fail = true;
    await checker.recheck();
    checker.saw(undefined);
    expect(notice()).toBe('0.28.47');
  });

  test('checks that come together read once', async () => {
    const { state, checker } = world('0.28.46', '0.28.47');
    await Promise.all([checker.recheck(), checker.recheck(), checker.recheck()]);
    expect(state.reads).toBe(1);
    await checker.recheck();
    expect(state.reads).toBe(2);
  });

  test('a page with no build never asks the Inbox', async () => {
    const { state, checker, notice } = world(null, '0.28.47');
    await checker.recheck();
    expect(state.reads).toBe(0);
    expect(notice()).toBeNull();
  });
});

describe('onPageReturn', () => {
  const pageshow = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted });

  test('the tab back from the back/forward cache or shown again rechecks; a fresh load and a hidden tab do not', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    let checks = 0;
    const stop = onPageReturn(win, doc, () => (checks += 1));
    win.dispatchEvent(pageshow(false));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(checks).toBe(0);
    win.dispatchEvent(pageshow(true));
    expect(checks).toBe(1);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(checks).toBe(2);
    stop();
    win.dispatchEvent(pageshow(true));
    expect(checks).toBe(2);
  });
});

describe('flushBeforeReload', () => {
  const removals: (() => void)[] = [];
  afterEach(() => {
    for (const remove of removals.splice(0)) remove();
  });

  test('reloads once every part has saved, waiting for the slow one', async () => {
    let saved = false;
    removals.push(registerReloadFlush(async () => true));
    removals.push(
      registerReloadFlush(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        saved = true;
        return true;
      }),
    );
    expect(await flushBeforeReload()).toBe(true);
    expect(saved).toBe(true);
  });

  test('a part that could not save, or threw, stops the reload', async () => {
    removals.push(registerReloadFlush(async () => true));
    const refused = registerReloadFlush(async () => false);
    expect(await flushBeforeReload()).toBe(false);
    refused();
    removals.push(
      registerReloadFlush(async () => {
        throw new Error('409');
      }),
    );
    expect(await flushBeforeReload()).toBe(false);
  });

  test('a save that never answers stops the reload once the wait runs out', async () => {
    removals.push(registerReloadFlush(() => new Promise<boolean>(() => {})));
    expect(await flushBeforeReload(30)).toBe(false);
  });

  test('a part that went away is not asked', async () => {
    const remove = registerReloadFlush(async () => false);
    remove();
    expect(await flushBeforeReload()).toBe(true);
  });
});
