/**
 * A reveal's "Turn it on" (revealTurnOn.ts; review of #2598, findings 1 and 3), driven with a save that fails as the
 * phone's does when the tailnet drops or the Inbox stops mid-save.
 *
 * What regresses: the Board row (or the Checklist) left showing under a toast that says it is not on, when the
 * settings re-read fails the same way; the owner-approved toast (its words, Open Settings) changing or going; a saved
 * answer not being what the page shows.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxToastModel } from './components/Toast';
import { REVEAL_TURN_ON_FAILED_MS, turnOnFromReveal, type RevealFeature } from './revealTurnOn';

type Settings = { serverSession: string; board?: { on: boolean }; steps?: { on: boolean } };

function world(save: () => Promise<{ on: boolean }>) {
  let settings: Settings | null = { serverSession: 's', board: { on: false }, steps: { on: false } };
  const log: string[] = [];
  const toasts: { toast: Omit<InboxToastModel, 'id'>; ms: number }[] = [];
  let seenBeforeSave: Settings | null = null;
  const run = (feature: RevealFeature) =>
    turnOnFromReveal<Settings>(feature, () => log.push('close'), {
      save: () => {
        seenBeforeSave = settings;
        return save();
      },
      setSettings: (update) => {
        settings = update(settings);
      },
      showToast: (toast, ms) => {
        log.push('toast');
        toasts.push({ toast, ms });
      },
      dismissToast: () => log.push('dismiss'),
      // The re-read fails too (the same dropped network): it changes nothing, as App's refreshSettings.
      refreshSettings: () => {
        log.push(`refresh:${JSON.stringify(settings)}`);
        return Promise.reject(new TypeError('Load failed')).catch(() => {});
      },
      openSettings: () => log.push('settings'),
    });
  return { run, log, toasts, settings: () => settings, seenBeforeSave: () => seenBeforeSave };
}

describe('Turn it on', () => {
  for (const [feature, lead] of [
    ['board', 'The Board isn’t on'],
    ['steps', 'The Checklist isn’t on'],
  ] as const) {
    test(`${feature}: a save that fails puts the switch back off before the re-read, and the toast says so with Open Settings`, async () => {
      const w = world(() => Promise.reject(new TypeError('Load failed')));
      await w.run(feature);
      // On at once (the row shows while it saves), then back off when it was not saved, even though the re-read failed.
      expect(w.seenBeforeSave()![feature]).toEqual({ on: true });
      expect(w.settings()![feature]).toEqual({ on: false });
      expect(w.settings()!.serverSession).toBe('s');
      // Off before the re-read starts, so a re-read that fails leaves it off.
      expect(w.log[0]).toBe('close');
      expect(JSON.parse(w.log[1]!.slice('refresh:'.length))[feature]).toEqual({ on: false });
      expect(w.log[2]).toBe('toast');
      expect(w.toasts).toHaveLength(1);
      const { toast, ms } = w.toasts[0]!;
      expect(ms).toBe(REVEAL_TURN_ON_FAILED_MS);
      expect(toast.icon).toBe('warn');
      expect(toast.lead).toBe(lead);
      expect(toast.detail).toBe('The setting wasn’t saved. You can turn it on in Settings.');
      expect(toast.action?.label).toBe('Open Settings');
      toast.action!.onPress();
      expect(w.log.slice(-2)).toEqual(['dismiss', 'settings']);
    });
  }

  test('a save the Inbox refuses (an answer, not a lost one) goes back off the same way', async () => {
    const w = world(() => Promise.reject(Object.assign(new Error('config.json could not be saved'), { status: 500 })));
    await w.run('board');
    expect(w.settings()!.board).toEqual({ on: false });
    expect(w.toasts.map((t) => t.toast.lead)).toEqual(['The Board isn’t on']);
  });

  test('saved: the page shows the switch as the Inbox answered it, and no toast', async () => {
    const w = world(() => Promise.resolve({ on: true }));
    await w.run('board');
    expect(w.settings()!.board).toEqual({ on: true });
    expect(w.settings()!.steps).toEqual({ on: false });
    expect(w.toasts).toHaveLength(0);
    expect(w.log).toEqual(['close']);
  });
});
