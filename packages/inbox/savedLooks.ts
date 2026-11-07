/**
 * What a settings read carries that the window also keeps on its own: the theme, the text size, the Shape board
 * style, the list's rows, the diff layout and voice. Each adopts config.json's value by its own rule (most: the
 * first read that names it, never over a choice made on this page first). App's `refreshSettings` hands every
 * read here, so a look added to the read is adopted with the others.
 */
import type { SettingsModel } from './api';
import { adoptSavedDiffStyle } from './diffStyle';
import { adoptSavedRows } from './listLook';
import { adoptSavedShapeStyle } from './shapeStyle';
import { adoptSavedTextSize } from './textSize';
import { adoptSavedTheme } from './theme';
import { adoptVoiceSettings } from './voice';

/** `mark`: `listLookReadMark()` taken before the read was sent. */
export function adoptSavedLooks(next: SettingsModel, mark: number): void {
  adoptSavedTheme(next.theme);
  adoptSavedTextSize(next.text_size);
  adoptSavedShapeStyle(next.shape_style);
  adoptSavedRows(next.rows, next.rows_rev, mark);
  adoptSavedDiffStyle(next.diff_style);
  adoptVoiceSettings(next.voice);
}
