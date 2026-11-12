import originalLight from './assets/theme-chooser/p-plannotator-light.webp';
import originalDark from './assets/theme-chooser/p-plannotator-dark.webp';
import modernLight from './assets/theme-chooser/p-plannotator-modern-light.webp';
import modernDark from './assets/theme-chooser/p-plannotator-modern-dark.webp';

export const THEME_CHOOSER_SHEETS = {
  plannotator: { light: originalLight, dark: originalDark },
  'plannotator-modern': { light: modernLight, dark: modernDark },
} as const;
