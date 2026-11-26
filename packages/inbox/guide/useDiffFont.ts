/**
 * The picked code font (Settings → Reviews → Code Font, `diffFontFamily`) for a diff the Inbox draws, with its web
 * stylesheet loaded, as code review does on startup (review-editor App.tsx: `loadDiffFont` on the saved font). Naming
 * the font alone leaves a web font unloaded after a reload until Settings is opened. `loadDiffFont` adds one link per
 * font however many diffs mount, and nothing for Theme Default or a font that is not one of the menu's web fonts.
 */
import { useEffect } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import { loadDiffFont } from '@plannotator/ui/utils/diffFonts';

export function useDiffFontFamily(): string {
  const fontFamily = useConfigValue('diffFontFamily');
  useEffect(() => {
    if (fontFamily) loadDiffFont(fontFamily);
  }, [fontFamily]);
  return fontFamily;
}
