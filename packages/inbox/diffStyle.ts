/**
 * Split or Unified in a guided review (approval "inbox-guide-diff-style",
 * #2107): the same setting code review keeps, `diffStyle` in @plannotator/ui's
 * config store. A choice here writes the `plannotator-diff-style` cookie at
 * once and config.json `diffOptions.diffStyle` through POST
 * /api/inbox/settings (`inboxServerSync` in theme.ts), the value code review
 * reads first; one made in code review reaches the Inbox the same two ways.
 */

import { configStore } from '@plannotator/ui/config';
import type { InboxDiffStyle } from './api';

let adopted = false;
let chosenHere = false;

/**
 * config.json's `diffOptions.diffStyle` wins over the cookie, as it does in
 * code review, but only from the first settings read, and never over a choice
 * made in this page before that read answered.
 */
export function adoptSavedDiffStyle(style: InboxDiffStyle | null | undefined): void {
  if (adopted) return;
  adopted = true;
  if ((style === 'split' || style === 'unified') && !chosenHere) configStore.init({ diffOptions: { diffStyle: style } });
}

/** The person's choice: the cookie now, config.json a moment later. */
export function chooseDiffStyle(style: InboxDiffStyle): void {
  chosenHere = true;
  configStore.set('diffStyle', style);
}

/** Tests only: forget the first settings read and any choice, as a fresh page would. */
export function resetInboxDiffStyleForTests(): void {
  adopted = false;
  chosenHere = false;
}
