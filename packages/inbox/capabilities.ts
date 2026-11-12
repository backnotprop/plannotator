/**
 * A capability switch saved here or in another window (`event: capabilities`, approval "inbox-thread-steps"): the
 * settings this window holds take each switch the frame names, and only those. The Board too (review of #2598,
 * finding 4: the owner's rule that settings sync everywhere), so a Board turned on in one window shows its sidebar
 * row in every other one (the phone, another tab) without a reload.
 */
import type { InboxEventHandlers, SettingsModel } from './api';

export type InboxCapabilities = Parameters<NonNullable<InboxEventHandlers['onCapabilities']>>[0];

type CapabilitySettings = Pick<SettingsModel, 'board' | 'steps' | 'bro' | 'float_drafts' | 'mark_read_warning' | 'code_review' | 'shape' | 'system' | 'chapter_diagrams'>;

/** True when the frame names any switch (an empty one: the window reads the settings again instead). */
export function namesCapability(capabilities: InboxCapabilities): boolean {
  return Boolean(capabilities.board || capabilities.steps || capabilities.bro || capabilities.float_drafts || capabilities.mark_read_warning || capabilities.code_review || capabilities.shape || capabilities.system || capabilities.chapter_diagrams);
}

export function withCapabilities<S extends CapabilitySettings>(current: S, capabilities: InboxCapabilities): S {
  const { board, steps, bro, float_drafts: floatDrafts, mark_read_warning: markReadWarning, code_review: codeReview, shape, system, chapter_diagrams: chapterDiagrams } = capabilities;
  return { ...current, ...(board ? { board } : {}), ...(steps ? { steps } : {}), ...(bro ? { bro } : {}), ...(floatDrafts ? { float_drafts: floatDrafts } : {}), ...(markReadWarning ? { mark_read_warning: markReadWarning } : {}), ...(codeReview ? { code_review: codeReview } : {}), ...(shape ? { shape } : {}), ...(system ? { system } : {}), ...(chapterDiagrams ? { chapter_diagrams: chapterDiagrams } : {}) };
}
