/**
 * A capability switch saved here or in another window (`event: capabilities`, approval "inbox-thread-steps"): the
 * settings this window holds take each switch the frame names, and only those. The Board too (review of #2598,
 * finding 4: the owner's rule that settings sync everywhere), so a Board turned on in one window shows its sidebar
 * row in every other one (the phone, another tab) without a reload. Plans as well: on or off from `plannotator plans`,
 * its row comes or goes in every open window, and a window on its page goes back to the Inbox. Thread panes too
 * (`split_view`, Settings → General → Appearance): every window, the one that saved it included, turns them on or off.
 */
import type { Dispatch, SetStateAction } from 'react';
import { reloadSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import type { InboxEventHandlers, SettingsModel } from './api';

export type InboxCapabilities = Parameters<NonNullable<InboxEventHandlers['onCapabilities']>>[0];

type CapabilitySettings = Pick<SettingsModel, 'board' | 'steps' | 'bro' | 'float_drafts' | 'mark_read_warning' | 'code_review' | 'shape' | 'system' | 'chapter_diagrams' | 'scheduled_threads' | 'diagrams' | 'plans'>;

/** True when the frame names any switch (an empty one: the window reads the settings again instead). */
export function namesCapability(capabilities: InboxCapabilities): boolean {
  return Boolean(capabilities.board || capabilities.steps || capabilities.bro || capabilities.float_drafts || capabilities.mark_read_warning || capabilities.split_view || capabilities.code_review || capabilities.shape || capabilities.system || capabilities.chapter_diagrams || capabilities.scheduled_threads || capabilities.diagrams || capabilities.plans);
}

export function withCapabilities<S extends CapabilitySettings>(current: S, capabilities: InboxCapabilities): S {
  const { board, steps, bro, float_drafts: floatDrafts, mark_read_warning: markReadWarning, split_view: splitView, code_review: codeReview, shape, system, chapter_diagrams: chapterDiagrams, scheduled_threads: scheduled, diagrams, plans } = capabilities;
  return { ...current, ...(board ? { board } : {}), ...(steps ? { steps } : {}), ...(bro ? { bro } : {}), ...(floatDrafts ? { float_drafts: floatDrafts } : {}), ...(markReadWarning ? { mark_read_warning: markReadWarning } : {}), ...(splitView ? { split_view: splitView } : {}), ...(codeReview ? { code_review: codeReview } : {}), ...(shape ? { shape } : {}), ...(system ? { system } : {}), ...(chapterDiagrams ? { chapter_diagrams: chapterDiagrams } : {}), ...(scheduled ? { scheduled_threads: { ...current.scheduled_threads, on: scheduled.on } } : {}), ...(diagrams ? { diagrams } : {}), ...(plans ? { plans } : {}) };
}

export function capabilityListener(setSettings: Dispatch<SetStateAction<SettingsModel | null>>, refresh: () => Promise<unknown>) {
  return (capabilities: InboxCapabilities) => {
    if (capabilities.code_review || capabilities.shape || capabilities.scheduled_threads || capabilities.diagrams) reloadSkillCatalog();
    if (namesCapability(capabilities)) setSettings((current) => current ? withCapabilities(current, capabilities) : current);
    else void refresh();
  };
}
