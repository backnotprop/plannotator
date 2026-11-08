/**
 * A capability switch saved here or in another window (`event: capabilities`, approval "inbox-thread-steps"): the
 * settings this window holds take each switch the frame names, and only those. The Board too (review of #2598,
 * finding 4: the owner's rule that settings sync everywhere), so a Board turned on in one window shows its sidebar
 * row in every other one (the phone, another tab) without a reload.
 */
import type { InboxEventHandlers, SettingsModel } from './api';

export type InboxCapabilities = Parameters<NonNullable<InboxEventHandlers['onCapabilities']>>[0];

type CapabilitySettings = Pick<SettingsModel, 'board' | 'steps' | 'bro' | 'code_review' | 'shape' | 'system'>;

/** True when the frame names any switch (an empty one: the window reads the settings again instead). */
export function namesCapability(capabilities: InboxCapabilities): boolean {
  return Boolean(capabilities.board || capabilities.steps || capabilities.bro || capabilities.code_review || capabilities.shape || capabilities.system);
}

export function withCapabilities<S extends CapabilitySettings>(current: S, capabilities: InboxCapabilities): S {
  const { board, steps, bro, code_review: codeReview, shape, system } = capabilities;
  return { ...current, ...(board ? { board } : {}), ...(steps ? { steps } : {}), ...(bro ? { bro } : {}), ...(codeReview ? { code_review: codeReview } : {}), ...(shape ? { shape } : {}), ...(system ? { system } : {}) };
}
