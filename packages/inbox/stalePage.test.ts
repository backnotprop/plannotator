import { afterEach, describe, expect, test } from 'bun:test';
import { reportUnsentReply } from './unsent';
import { createStalePageChecker, flushBeforeReload, newerInbox, onPageReturn, registerReloadFlush, reloadOntoInbox, type ReloadOntoInbox } from './stalePage';

describe('newerInbox', () => {
  test('the same release is no notice', () => {
    expect(newerInbox('0.28.46', '0.28.46')).toBeNull();
    expect(newerInbox('0.28.46', 'v0.28.46')).toBeNull();
  });

  test('a newer release names itself, whichever part moved', () => {
    expect(newerInbox('0.28.46', '0.28.47')).toBe('0.28.47');
    expect(newerInbox('0.28.46', '0.29.0')).toBe('0.29.0');
    expect(newerInbox('0.28.46', '1.0.0')).toBe('1.0.0');
    expect(newerInbox('0.28.9', '0.28.10')).toBe('0.28.10');
  });

  test('an older Inbox never asks for a reload', () => {
    expect(newerInbox('0.28.46', '0.28.10')).toBeNull();
    expect(newerInbox('0.28.46', '0.27.99')).toBeNull();
  });

  test('a development build on either side is skipped', () => {
    expect(newerInbox('0.28.46', 'dev')).toBeNull();
    expect(newerInbox('0.28.46', '0.0.0-dev')).toBeNull();
    expect(newerInbox('0.28.46', '0.0.0')).toBeNull();
    expect(newerInbox('0.0.0', '0.28.46')).toBeNull();
    expect(newerInbox(null, '0.28.47')).toBeNull();
    expect(newerInbox('0.28.46', '0.28.47-rc.1')).toBeNull();
    expect(newerInbox('0.28.46', undefined)).toBeNull();
  });
});

function world(page: string | null, inbox: string) {
  const state = { inbox, reads: 0, fail: false, paused: false, shown: [] as (string | null)[] };
  const checker = createStalePageChecker(
    page,
    async () => {
      state.reads += 1;
      if (state.fail) throw new Error('offline');
      return state.inbox;
    },
    (next) => state.shown.push(next),
    () => state.paused,
  );
  const notice = () => state.shown.at(-1) ?? null;
  return { state, checker, notice };
}

describe('createStalePageChecker', () => {
  test('a reconnect after the Inbox restarted onto a newer release shows the notice', async () => {
    const { state, checker, notice } = world('0.28.46', '0.28.46');
    checker.saw('0.28.46');
    expect(notice()).toBeNull();
    state.inbox = '0.28.47';
    await checker.recheck();
    expect(notice()).toBe('0.28.47');
  });

  test('a dismissed release stays hidden on every later check; only a newer release shows it again', async () => {
    const { state, checker, notice } = world('0.28.46', '0.28.47');
    checker.saw('0.28.47');
    checker.dismiss();
    expect(notice()).toBeNull();
    await checker.recheck();
    await checker.recheck();
    expect(notice()).toBeNull();
    state.inbox = '0.28.48';
    await checker.recheck();
    expect(notice()).toBe('0.28.48');
  });

  test('during the person\'s own Restart nothing is read or shown', async () => {
    const { state, checker, notice } = world('0.28.46', '0.28.46');
    checker.saw('0.28.46');
    state.paused = true;
    state.inbox = '0.28.47';
    await checker.recheck();
    checker.saw('0.28.47');
    expect(state.reads).toBe(0);
    expect(notice()).toBeNull();
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

  test('reply words the page holds unsaved anywhere (no "Leave page?" on a phone) stop the reload', async () => {
    removals.push(registerReloadFlush(async () => true));
    try {
      reportUnsentReply({ subject: 'Retry worker', files: true });
      expect(await flushBeforeReload()).toBe(false);
    } finally {
      reportUnsentReply(null);
    }
    expect(await flushBeforeReload()).toBe(true);
  });
});

describe('reloadOntoInbox', () => {
  const SELF = 'ibx_01JC0000000000000000000000';
  function page(options: { health?: () => Promise<{ serverSession: string; inbox_id?: string }>; self?: string | null; saved?: boolean }) {
    const state = { session: 'old' as string | null, flushed: [] as (string | null)[], reloads: 0 };
    const deps: ReloadOntoInbox = {
      readHealth: options.health ?? (async () => ({ serverSession: 'old', inbox_id: SELF })),
      selfId: () => (options.self === undefined ? SELF : options.self),
      session: { get: () => state.session, set: (value) => (state.session = value) },
      flush: async () => {
        state.flushed.push(state.session);
        return options.saved ?? true;
      },
      reload: () => (state.reloads += 1),
    };
    return { state, deps };
  }

  test('the Inbox restarted under the page: the saves carry its new session, then the page reloads', async () => {
    const { state, deps } = page({ health: async () => ({ serverSession: 'new', inbox_id: SELF }) });
    expect(await reloadOntoInbox(deps)).toBe(true);
    expect(state.flushed).toEqual(['new']);
    expect(state.reloads).toBe(1);
  });

  test('saves that did not all land: no reload, and the page keeps its first session (its writes are refused again)', async () => {
    const { state, deps } = page({ health: async () => ({ serverSession: 'new', inbox_id: SELF }), saved: false });
    expect(await reloadOntoInbox(deps)).toBe(false);
    expect(state.flushed).toEqual(['new']);
    expect(state.session).toBe('old');
    expect(state.reloads).toBe(0);
  });

  test('another Inbox on the same port, or one the page cannot name, never gets the session', async () => {
    for (const setup of [{ health: async () => ({ serverSession: 'new', inbox_id: 'ibx_01JC0000000000000000000099' }) }, { health: async () => ({ serverSession: 'new' }) }, { health: async () => ({ serverSession: 'new', inbox_id: SELF }), self: null }]) {
      const { state, deps } = page(setup);
      await reloadOntoInbox(deps);
      expect(state.flushed).toEqual(['old']);
      expect(state.session).toBe('old');
    }
  });

  test('an Inbox that does not answer: the saves still run, with the page\'s own session', async () => {
    const { state, deps } = page({ health: () => Promise.reject(new Error('timed out')) });
    expect(await reloadOntoInbox(deps)).toBe(true);
    expect(state.flushed).toEqual(['old']);
  });
});
