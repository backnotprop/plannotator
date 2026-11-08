/**
 * A window hearing `event: capabilities` (capabilities.ts; review of #2598, finding 4: the owner's rule that settings
 * sync everywhere): the frame as the Inbox sends it, through the page's frame reader, onto the settings App holds.
 *
 * What regresses: a Board turned on in one window (Settings, or a reveal's "Turn it on") not reaching the phone or
 * another tab's sidebar until a reload; a frame changing a switch it does not name; a malformed Board value applied.
 */
import { describe, expect, test } from 'bun:test';
import { dispatchInboxFrame, type InboxEventHandlers, type SettingsModel } from './api';
import { namesCapability, withCapabilities } from './capabilities';

type Held = Pick<SettingsModel, 'serverSession' | 'board' | 'steps' | 'bro' | 'float_drafts' | 'code_review' | 'shape' | 'system'>;

/** What App's onCapabilities does with a frame: apply what it names, else read the settings again. */
function hear(data: string, settings: Held): { settings: Held; reread: boolean } {
  let next = settings;
  let reread = false;
  const handlers: InboxEventHandlers = {
    onRecord: () => {},
    onStatus: () => {},
    onCapabilities: (capabilities) => {
      if (namesCapability(capabilities)) next = withCapabilities(next, capabilities);
      else reread = true;
    },
  };
  dispatchInboxFrame({ name: 'capabilities', id: null, data }, handlers);
  return { settings: next, reread };
}

const OFF: Held = { serverSession: 's', board: { on: false }, steps: { on: true }, code_review: { on: true } };

describe('event: capabilities', () => {
  test('the Board turned on in another window: this window takes it (its sidebar row shows), every other switch as it was', () => {
    // The frame the Inbox sends when the Board is saved (inbox.ts onCapabilities): every window-followed switch.
    const { settings, reread } = hear(JSON.stringify({ board: { on: true }, steps: { on: true } }), OFF);
    expect(reread).toBe(false);
    expect(settings).toEqual({ serverSession: 's', board: { on: true }, steps: { on: true }, code_review: { on: true } });
    // And off again.
    expect(hear(JSON.stringify({ board: { on: false }, steps: { on: true } }), settings).settings.board).toEqual({ on: false });
  });

  test('Bro mode turned on in another window: this window takes it, every other switch as it was', () => {
    const { settings, reread } = hear(JSON.stringify({ bro: { on: true } }), { ...OFF, bro: { on: false } });
    expect(reread).toBe(false);
    expect(settings).toEqual({ ...OFF, bro: { on: true } });
  });

  test('floating reply drafts turned on, then off, in another window: this window follows; a frame without it leaves it', () => {
    const on = hear(JSON.stringify({ board: { on: false }, steps: { on: true }, bro: { on: false }, float_drafts: { on: true } }), { ...OFF, float_drafts: { on: false } });
    expect(on.reread).toBe(false);
    expect(on.settings.float_drafts).toEqual({ on: true });
    expect(hear(JSON.stringify({ board: { on: false }, steps: { on: true }, float_drafts: { on: false } }), on.settings).settings.float_drafts).toEqual({ on: false });
    // The server leaves it out of a frame while it is off and was not the change: the window keeps what it has.
    expect(hear(JSON.stringify({ board: { on: true }, steps: { on: true } }), on.settings).settings.float_drafts).toEqual({ on: true });
  });

  test('a frame without the Board leaves it; a malformed Board value is not applied', () => {
    const on = { ...OFF, board: { on: true } };
    expect(hear(JSON.stringify({ steps: { on: false } }), on).settings).toEqual({ ...on, steps: { on: false } });
    expect(hear(JSON.stringify({ board: { on: 'yes' }, steps: { on: true } }), OFF).settings.board).toEqual({ on: false });
    // Nothing named (an empty frame): the window reads the settings again.
    expect(hear('{}', OFF).reread).toBe(true);
  });

  test('System turned on in another window: this window takes it (the Reviews System button shows)', () => {
    const { settings } = hear(JSON.stringify({ board: { on: false }, steps: { on: true }, code_review: { on: true }, system: { on: true } }), { ...OFF, system: { on: false } });
    expect(settings.system).toEqual({ on: true });
    expect(hear(JSON.stringify({ board: { on: false }, system: { on: 'yes' } }), { ...OFF, system: { on: false } }).settings.system).toEqual({ on: false });
  });
});
