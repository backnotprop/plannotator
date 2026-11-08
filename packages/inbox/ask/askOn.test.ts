/**
 * Ask AI has no switch (approval "inbox-ask-ai-flow", addendum 2026-11-07): the
 * page offers it whatever the settings say about Ask or Code review, and keeps
 * only the exceptions that are not switches: the tour, a tailnet guest, and a
 * page whose settings have not come yet (it does not know whose page it is).
 */
import { expect, test } from 'bun:test';
import { inboxAskOn, type SettingsModel } from '../api';

const owner = { via: 'local' } as SettingsModel;

test('on with no ask_ai and Code review off: no switch turns it on', () => {
  expect(inboxAskOn(owner, false)).toBe(true);
  expect(inboxAskOn({ ...owner, code_review: { on: false } } as SettingsModel, false)).toBe(true);
  expect(inboxAskOn({ via: 'tailnet', guest: false } as SettingsModel, false)).toBe(true);
});

test('the tour, a tailnet guest and settings not read yet still hide it', () => {
  expect(inboxAskOn(owner, true)).toBe(false);
  expect(inboxAskOn({ via: 'tailnet', guest: true } as SettingsModel, false)).toBe(false);
  // Over the tailnet an Inbox that does not say counts as a guest.
  expect(inboxAskOn({ via: 'tailnet' } as SettingsModel, false)).toBe(false);
  expect(inboxAskOn(null, false)).toBe(false);
});
