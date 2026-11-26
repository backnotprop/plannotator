/**
 * How the Inbox's diffs are drawn (approvals "inbox-guide-diff-style", #2107,
 * and "diff-controls-headers"): code review's own settings, `diff*` in
 * @plannotator/ui's config store. A choice here (the Split / Unified button,
 * the "Diff display" popover) writes its `plannotator-diff-*` cookie at once
 * and config.json `diffOptions` through POST /api/inbox/settings
 * `diff_options` (`inboxServerSync` in theme.ts), the value code review reads
 * first; one made in code review reaches the Inbox the same two ways. The
 * Inbox may run on another host than code review, where the cookies are not
 * shared, so config.json is what carries a choice across.
 *
 * Hide whitespace and the minimap are not here: the Inbox does not show them.
 * Whole file is: code review's own switch, which the Inbox's diffs obey. So
 * are the code font and size and Power Up's switch and motion, which
 * Settings → Reviews (reviewSettings/) sets as code review's Settings does.
 */

import { configStore } from '@plannotator/ui/config';
import type { DiffDisplaySetting } from '@plannotator/ui/components/DiffDisplayOptions';
import type { SettingValue } from '@plannotator/ui/config';
import type { InboxDiffOptions } from './api';

/** The settings the Inbox shows and saves. */
export type InboxDiffSetting = 'diffStyle' | 'diffPowerUp' | Exclude<DiffDisplaySetting, 'diffHideWhitespace' | 'diffMinimap'> | 'diffFontFamily' | 'diffFontSize' | 'diffPowerUpMotion';
type WireKey = keyof InboxDiffOptions;

/** Each setting's name on the wire, and its field in config.json `diffOptions` (what the config store's sync payload carries). */
const FIELDS: Record<InboxDiffSetting, { wire: WireKey; config: string }> = {
  diffStyle: { wire: 'diff_style', config: 'diffStyle' },
  diffOverflow: { wire: 'overflow', config: 'overflow' },
  diffIndicators: { wire: 'indicators', config: 'diffIndicators' },
  diffLineDiffType: { wire: 'line_diff_type', config: 'lineDiffType' },
  diffShowLineNumbers: { wire: 'line_numbers', config: 'showLineNumbers' },
  diffShowBackground: { wire: 'background', config: 'showDiffBackground' },
  diffLineBgIntensity: { wire: 'background_intensity', config: 'lineBgIntensity' },
  diffTabSize: { wire: 'tab_size', config: 'tabSize' },
  diffSemantic: { wire: 'semantic', config: 'semantic' },
  diffExpandUnchanged: { wire: 'expand_unchanged', config: 'expandUnchanged' },
  diffFontFamily: { wire: 'font_family', config: 'fontFamily' },
  diffFontSize: { wire: 'font_size', config: 'fontSize' },
  // Power Up's switch: Settings → Reviews draws it, and a choice made in code review holds on every address (guide/usePowerUp.ts).
  diffPowerUp: { wire: 'power_up', config: 'powerUp' },
  diffPowerUpMotion: { wire: 'power_up_motion', config: 'powerUpMotion' },
};

/** Whether a setting is one the Inbox saves to config.json `diffOptions`. */
export function isInboxDiffSetting(setting: string): setting is InboxDiffSetting {
  return Object.hasOwn(FIELDS, setting);
}
const SETTINGS = Object.keys(FIELDS) as InboxDiffSetting[];

let adopted = false;
const chosenHere = new Set<InboxDiffSetting>();

/**
 * config.json's `diffOptions` wins over the cookies, as it does in code
 * review, but only from the first settings read, and per field: one the
 * person chose on this page before that read answered keeps the page's value.
 * `legacyStyle` is the `diff_style` an Inbox answers when it has no
 * `diff_options`.
 */
export function adoptSavedDiffOptions(saved: Partial<InboxDiffOptions> | null | undefined, legacyStyle?: InboxDiffOptions['diff_style']): void {
  if (adopted) return;
  adopted = true;
  const wire: Partial<InboxDiffOptions> = { ...(saved ?? {}) };
  if (wire.diff_style == null && legacyStyle != null) wire.diff_style = legacyStyle;
  const diffOptions: Record<string, unknown> = {};
  for (const setting of SETTINGS) {
    const value = wire[FIELDS[setting].wire];
    if (value != null && !chosenHere.has(setting)) diffOptions[FIELDS[setting].config] = value;
  }
  // The store checks each value (an unknown one keeps the cookie's).
  if (Object.keys(diffOptions).length > 0) configStore.init({ diffOptions });
}

/** The person's choice: the cookie now, config.json a moment later. */
export function chooseDiffOption<K extends InboxDiffSetting>(setting: K, value: SettingValue<K>): void {
  chosenHere.add(setting);
  configStore.set(setting, value);
}

/** The config store's sync payload (`diffOptions`, config.json's names) as POST /api/inbox/settings `diff_options`; null when it has none the Inbox saves. */
export function diffOptionsToWire(diffOptions: unknown): Partial<InboxDiffOptions> | null {
  if (!diffOptions || typeof diffOptions !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const setting of SETTINGS) {
    const value = (diffOptions as Record<string, unknown>)[FIELDS[setting].config];
    if (value !== undefined) out[FIELDS[setting].wire] = value;
  }
  return Object.keys(out).length > 0 ? (out as Partial<InboxDiffOptions>) : null;
}

/** Tests only: forget the first settings read and any choice, as a fresh page would. */
export function resetInboxDiffOptionsForTests(): void {
  adopted = false;
  chosenHere.clear();
}
