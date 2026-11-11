import { configStore } from '@plannotator/ui/config';
import type { DiffDisplaySetting } from '@plannotator/ui/components/DiffDisplayOptions';
import type { SettingValue } from '@plannotator/ui/config';
import type { InboxDiffOptions } from './api';

export type InboxDiffSetting = 'diffStyle' | Exclude<DiffDisplaySetting, 'diffExpandUnchanged' | 'diffHideWhitespace'>;
type WireKey = keyof InboxDiffOptions;

const FIELDS: Record<InboxDiffSetting, { wire: WireKey; config: string }> = {
  diffStyle: { wire: 'diff_style', config: 'diffStyle' },
  diffOverflow: { wire: 'overflow', config: 'overflow' },
  diffIndicators: { wire: 'indicators', config: 'diffIndicators' },
  diffLineDiffType: { wire: 'line_diff_type', config: 'lineDiffType' },
  diffShowLineNumbers: { wire: 'line_numbers', config: 'showLineNumbers' },
  diffShowBackground: { wire: 'background', config: 'showDiffBackground' },
  diffLineBgIntensity: { wire: 'background_intensity', config: 'lineBgIntensity' },
  diffTabSize: { wire: 'tab_size', config: 'tabSize' },
};
const SETTINGS = Object.keys(FIELDS) as InboxDiffSetting[];

let adopted = false;
const chosenHere = new Set<InboxDiffSetting>();

/**
 * config.json's `diffOptions` wins over the cookies, but only from the first settings read and per field:
 * a field chosen on this page before that read keeps the page's value.
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
  if (Object.keys(diffOptions).length > 0) configStore.init({ diffOptions });
}

export function chooseDiffOption<K extends InboxDiffSetting>(setting: K, value: SettingValue<K>): void {
  chosenHere.add(setting);
  configStore.set(setting, value);
}

export function diffOptionsToWire(diffOptions: unknown): Partial<InboxDiffOptions> | null {
  if (!diffOptions || typeof diffOptions !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const setting of SETTINGS) {
    const value = (diffOptions as Record<string, unknown>)[FIELDS[setting].config];
    if (value !== undefined) out[FIELDS[setting].wire] = value;
  }
  return Object.keys(out).length > 0 ? (out as Partial<InboxDiffOptions>) : null;
}

export function resetInboxDiffOptionsForTests(): void {
  adopted = false;
  chosenHere.clear();
}
