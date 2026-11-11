/** Both Transparent builds are drawn and the theme shows one, so a light/dark switch needs no redraw. Its own script: the window splits at every dynamic import, so these bytes load on first use. */
import { TAB_ICON_ART } from '../tabIconArt';
import transparentLight from '../assets/agent-marks/transparent-light.svg';
import transparentDark from '../assets/agent-marks/transparent-dark.svg';
import type { OurFace } from './faceChoices';
import { GLASS_COLOURS, glassDataUrl } from './glassArt';

export const AGENT_FACE_SRC: Readonly<Record<OurFace, string | { light: string; dark: string }>> = {
  ...(Object.fromEntries(GLASS_COLOURS.map((colour) => [colour.id, glassDataUrl(colour)])) as Record<(typeof GLASS_COLOURS)[number]['id'], string>),
  transparent: { light: transparentLight, dark: transparentDark },
  totman: TAB_ICON_ART.totman,
};

const picture = (src: string, className = 'am-art') => `<img class="${className}" src="${src}" alt="" draggable="false">`;

export const AGENT_FACE_ART: Readonly<Record<OurFace, string>> = Object.fromEntries(
  Object.entries(AGENT_FACE_SRC).map(([face, src]) => [face, typeof src === 'string' ? picture(src) : picture(src.light, 'am-art am-art-l') + picture(src.dark, 'am-art am-art-d')]),
) as Record<OurFace, string>;
