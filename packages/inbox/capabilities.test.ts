import { describe, expect, test } from 'bun:test';
import { dispatchInboxFrame, type InboxEventHandlers, type SettingsModel } from './api';
import { namesCapability, withCapabilities } from './capabilities';

type Held = Pick<SettingsModel, 'serverSession' | 'board' | 'steps' | 'bro' | 'float_drafts' | 'code_review' | 'shape' | 'system'>;

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
    const { settings, reread } = hear(JSON.stringify({ board: { on: true }, steps: { on: true } }), OFF);
    expect(reread).toBe(false);
    expect(settings).toEqual({ serverSession: 's', board: { on: true }, steps: { on: true }, code_review: { on: true } });
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
    expect(hear(JSON.stringify({ board: { on: true }, steps: { on: true } }), on.settings).settings.float_drafts).toEqual({ on: true });
  });

  test('a frame without the Board leaves it; a malformed Board value is not applied', () => {
    const on = { ...OFF, board: { on: true } };
    expect(hear(JSON.stringify({ steps: { on: false } }), on).settings).toEqual({ ...on, steps: { on: false } });
    expect(hear(JSON.stringify({ board: { on: 'yes' }, steps: { on: true } }), OFF).settings.board).toEqual({ on: false });
    expect(hear('{}', OFF).reread).toBe(true);
  });

  test('System turned on in another window: this window takes it (the Reviews System button shows)', () => {
    const { settings } = hear(JSON.stringify({ board: { on: false }, steps: { on: true }, code_review: { on: true }, system: { on: true } }), { ...OFF, system: { on: false } });
    expect(settings.system).toEqual({ on: true });
    expect(hear(JSON.stringify({ board: { on: false }, system: { on: 'yes' } }), { ...OFF, system: { on: false } }).settings.system).toEqual({ on: false });
  });
});
