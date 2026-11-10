/**
 * The "themes" dialog's desktop sheets (components/ThemeChooser.tsx): the Inbox in Plannotator Original and Modern,
 * light and dark, 1360x925 WebP each (a 1000x680 window at 2x). In their own script: the Inbox window splits at every
 * dynamic import, so these bytes load only when the dialog is about to open (themeChooserArt.ts), never at page load.
 * Retake them with `bun scripts/theme-chooser-shots.ts` (after `bun run build:hook`).
 */
import originalLight from './assets/theme-chooser/d-plannotator-light.webp';
import originalDark from './assets/theme-chooser/d-plannotator-dark.webp';
import modernLight from './assets/theme-chooser/d-plannotator-modern-light.webp';
import modernDark from './assets/theme-chooser/d-plannotator-modern-dark.webp';

export const THEME_CHOOSER_SHEETS = {
  plannotator: { light: originalLight, dark: originalDark },
  'plannotator-modern': { light: modernLight, dark: modernDark },
} as const;
