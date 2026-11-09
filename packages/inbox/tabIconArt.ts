/**
 * The tab icon dialog's large pictures (components/TabIconChoice.tsx), in their own script: the Inbox window splits at
 * every dynamic import, so these bytes load only when the dialog is armed. Glass is the approved PWA icon
 * (`icon-192.png` of the glass set, 2026-11-09), Face the 256 px build of the same art as the app's 64 px Face; P is
 * the app's own 192 px build. Until this script is in, the dialog draws each style's app PNG.
 */
import { P_FAVICON_PNG_DATA_URL, type FaviconStyle } from '@plannotator/core/favicon';
import glass from './assets/tab-icon/glass-192.png';
import face from './assets/tab-icon/face-256.png';

export const TAB_ICON_ART: Readonly<Record<FaviconStyle, string>> = { glass, totman: face, classic: P_FAVICON_PNG_DATA_URL };
