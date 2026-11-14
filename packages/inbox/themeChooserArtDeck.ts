/**
 * The "themes" dialog's phone sheets (components/ThemeChooser.tsx): the same four views as themeChooserArtFan.ts, from
 * a 390x560 window at 3x cut to 600x862 WebP. In their own script, loaded only when the dialog is about to open on a
 * phone (themeChooserArt.ts).
 */
import originalLight from './assets/theme-chooser/p-plannotator-light.webp';
import originalDark from './assets/theme-chooser/p-plannotator-dark.webp';
import modernLight from './assets/theme-chooser/p-plannotator-modern-light.webp';
import modernDark from './assets/theme-chooser/p-plannotator-modern-dark.webp';

export const THEME_CHOOSER_SHEETS = {
  plannotator: { light: originalLight, dark: originalDark },
  'plannotator-modern': { light: modernLight, dark: modernDark },
} as const;
