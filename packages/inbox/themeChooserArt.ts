import { STAR_ASK_DISPLAY_FONT } from '@plannotator/ui/utils/starAskFonts';
import type { ThemeChooserHalf, ThemeChooserThemeId } from './themeChooser';

export interface ThemeChooserArt {
  sheets: Readonly<Record<ThemeChooserThemeId, Readonly<Record<ThemeChooserHalf, string>>>>;
  own: Readonly<Record<string, string>>;
}

const DECODE_WAIT_MS = 4_000;

async function decoded(src: string): Promise<void> {
  if (typeof Image !== 'function') return;
  const image = new Image();
  image.src = src;
  if (typeof image.decode === 'function') await image.decode().catch(() => undefined);
}

export async function loadThemeChooserArt(deck: boolean): Promise<ThemeChooserArt> {
  const [sheets, own] = await Promise.all([deck ? import('./themeChooserArtDeck') : import('./themeChooserArtFan'), import('./themeChooserArtOwn')]);
  const art: ThemeChooserArt = { sheets: sheets.THEME_CHOOSER_SHEETS, own: own.THEME_CHOOSER_OWN_SHEETS };
  const urls = [...Object.values(art.sheets).flatMap((pair) => [pair.light, pair.dark]), ...Object.values(art.own)];
  const ready = Promise.all([...urls.map(decoded), Promise.resolve(document.fonts?.load?.(`900 34px "${STAR_ASK_DISPLAY_FONT}"`)).catch(() => undefined)]);
  await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, DECODE_WAIT_MS))]);
  return art;
}
