/**
 * Our four faces in the agent marks' click cycle (approval "inbox-agent-icon-motion"): Glass, Yellow and Face are the
 * tab icon dialog's pictures (tabIconArt.ts, the favicon art), and Transparent is the yellow glass set's goggles with
 * no tile: on light the ink-frame mark (mark/mark-clean-transparent.svg), on dark the yellow-frame pixel mark
 * (pixel/fav-48-transparent.svg), each framed to the goggles (only the viewBox changed). Both Transparent builds are
 * drawn and the theme shows one (inbox agents.css), so a switch of light and dark needs no redraw.
 *
 * In its own script: the Inbox window splits at every dynamic import, so these bytes load on the first click.
 */
import { TAB_ICON_ART } from '../tabIconArt';
import transparentLight from '../assets/agent-marks/transparent-light.svg';
import transparentDark from '../assets/agent-marks/transparent-dark.svg';
import type { AgentFace } from './motion';

const picture = (src: string, className = 'am-art') => `<img class="${className}" src="${src}" alt="" draggable="false">`;

export const AGENT_FACE_ART: Readonly<Record<Exclude<AgentFace, 'agent'>, string>> = {
  glass: picture(TAB_ICON_ART.glass),
  yellow: picture(TAB_ICON_ART.yellow),
  transparent: picture(transparentLight, 'am-art am-art-l') + picture(transparentDark, 'am-art am-art-d'),
  totman: picture(TAB_ICON_ART.totman),
};
