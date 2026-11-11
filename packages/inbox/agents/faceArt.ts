/**
 * Our faces in the agent marks' picker and click cycle (approval "inbox-agent-icon-motion"): the Glass colours are
 * vectors (glassArt.ts, Black and Yellow redrawing the tab icon's Glass and Yellow), Face is the tab icon dialog's
 * picture (tabIconArt.ts), and Transparent is the yellow glass set's goggles with no tile: on light the ink-frame mark
 * (mark/mark-clean-transparent.svg), on dark the yellow-frame pixel mark (pixel/fav-48-transparent.svg), each framed
 * to the goggles (only the viewBox changed). Both Transparent builds are drawn and the theme shows one (inbox
 * agents.css), so a switch of light and dark needs no redraw.
 *
 * In its own script: the Inbox window splits at every dynamic import, so these bytes load on the first click or the
 * first look at the picker.
 */
import { TAB_ICON_ART } from '../tabIconArt';
import transparentLight from '../assets/agent-marks/transparent-light.svg';
import transparentDark from '../assets/agent-marks/transparent-dark.svg';
import type { OurFace } from './faceChoices';
import { GLASS_COLOURS, glassDataUrl } from './glassArt';

/** Each face's picture: one source, or Transparent's light and dark pair. */
export const AGENT_FACE_SRC: Readonly<Record<OurFace, string | { light: string; dark: string }>> = {
  ...(Object.fromEntries(GLASS_COLOURS.map((colour) => [colour.id, glassDataUrl(colour)])) as Record<(typeof GLASS_COLOURS)[number]['id'], string>),
  transparent: { light: transparentLight, dark: transparentDark },
  totman: TAB_ICON_ART.totman,
};

const picture = (src: string, className = 'am-art') => `<img class="${className}" src="${src}" alt="" draggable="false">`;

/** Each face as markup for a mark (our own sources only). */
export const AGENT_FACE_ART: Readonly<Record<OurFace, string>> = Object.fromEntries(
  Object.entries(AGENT_FACE_SRC).map(([face, src]) => [face, typeof src === 'string' ? picture(src) : picture(src.light, 'am-art am-art-l') + picture(src.dark, 'am-art am-art-d')]),
) as Record<OurFace, string>;
