/**
 * "Choose your own" in the "themes" dialog: the Inbox in three more themes (the desktop view, drawn small). In their
 * own script, loaded with the sheets (themeChooserArt.ts).
 */
import catppuccin from './assets/theme-chooser/d-catppuccin-dark.webp';
import solarized from './assets/theme-chooser/d-solarized-light.webp';
import tokyoNight from './assets/theme-chooser/d-tokyo-night-dark.webp';

export const THEME_CHOOSER_OWN_SHEETS = { catppuccin, solarized, 'tokyo-night': tokyoNight } as const;
