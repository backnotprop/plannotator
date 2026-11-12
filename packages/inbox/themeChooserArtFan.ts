import originalLight from './assets/theme-chooser/d-plannotator-light.webp';
import originalDark from './assets/theme-chooser/d-plannotator-dark.webp';
import modernLight from './assets/theme-chooser/d-plannotator-modern-light.webp';
import modernDark from './assets/theme-chooser/d-plannotator-modern-dark.webp';

export const THEME_CHOOSER_SHEETS = {
  plannotator: { light: originalLight, dark: originalDark },
  'plannotator-modern': { light: modernLight, dark: modernDark },
} as const;
