/**
 * A capability switch saved here or in another window (`event: capabilities`, approval "inbox-thread-steps"): the
 * settings this window holds take each switch the frame names, and only those. The Board too (review of #2598,
 * finding 4: the owner's rule that settings sync everywhere), so a Board turned on in one window shows its sidebar
 * row in every other one (the phone, another tab) without a reload. Plans as well: on or off from `plannotator plans`,
 * its row comes or goes in every open window, and a window on its page goes back to the Inbox. Thread panes too
 * (`split_view`, Settings → General → Appearance): every window, the one that saved it included, turns them on or off.
 * Decision mode too (`decision_mode`, named while it is off and by the save that changed it): every window's Decide
 * row comes or goes at once; the frame carries only `on`, so what the settings read said of the environment stays.
 */
import type { InboxEventHandlers, InboxExperimentalSettings, SettingsModel } from './api';

export type InboxCapabilities = Parameters<NonNullable<InboxEventHandlers['onCapabilities']>>[0];

type CapabilitySettings = Pick<SettingsModel, 'board' | 'decision_mode' | 'steps' | 'bro' | 'float_drafts' | 'mark_read_warning' | 'code_review' | 'system' | 'chapter_diagrams' | 'scheduled_threads' | 'plans' | 'experimental'>;

/**
 * A frame's `experimental` (Decision mode and Grid), which it carries only when one of them was the change: saved in
 * another window, or a linked computer's flip taken here (one set of capabilities, inbox-capability-set.ts in the
 * server). Read by name; anything else is none.
 */
export function experimentalOfFrame(value: unknown): InboxExperimentalSettings | undefined {
  const v = value && typeof value === 'object' ? (value as { decision_mode?: unknown; grid?: unknown }) : null;
  const one = (s: unknown) => {
    const x = s && typeof s === 'object' ? (s as { on?: unknown; env?: unknown }) : null;
    return x && typeof x.on === 'boolean' ? { on: x.on, env: typeof x.env === 'boolean' ? x.env : null } : null;
  };
  const decisionMode = one(v?.decision_mode);
  if (!decisionMode) return undefined;
  const grid = one(v?.grid);
  return { decision_mode: decisionMode, ...(grid ? { grid } : {}) };
}

/** True when the frame names any switch (an empty one: the window reads the settings again instead). */
export function namesCapability(capabilities: InboxCapabilities): boolean {
  return Boolean(capabilities.board || capabilities.decision_mode || capabilities.steps || capabilities.bro || capabilities.float_drafts || capabilities.mark_read_warning || capabilities.split_view || capabilities.code_review || capabilities.system || capabilities.chapter_diagrams || capabilities.scheduled_threads || capabilities.plans || capabilities.experimental);
}

export function withCapabilities<S extends CapabilitySettings>(current: S, capabilities: InboxCapabilities): S {
  const { board, decision_mode: decisionMode, steps, bro, float_drafts: floatDrafts, mark_read_warning: markReadWarning, split_view: splitView, code_review: codeReview, system, chapter_diagrams: chapterDiagrams, scheduled_threads: scheduled, plans, experimental } = capabilities;
  return { ...current, ...(board ? { board } : {}), ...(decisionMode ? { decision_mode: { ...current.decision_mode, ...decisionMode } } : {}), ...(steps ? { steps } : {}), ...(bro ? { bro } : {}), ...(floatDrafts ? { float_drafts: floatDrafts } : {}), ...(markReadWarning ? { mark_read_warning: markReadWarning } : {}), ...(splitView ? { split_view: splitView } : {}), ...(codeReview ? { code_review: codeReview } : {}), ...(system ? { system } : {}), ...(chapterDiagrams ? { chapter_diagrams: chapterDiagrams } : {}), ...(scheduled ? { scheduled_threads: { ...current.scheduled_threads, on: scheduled.on } } : {}), ...(plans ? { plans } : {}), ...(experimental ? { experimental } : {}) };
}
