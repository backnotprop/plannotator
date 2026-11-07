/**
 * How every Shape board is drawn (approval "shape-board-style-switch"): Settings → Capabilities → Board style,
 * Rounded or Sharp, Sharp by default. Every board the window shows follows it at once (the board, the grid's
 * previews), old ones too: the renderer restyles them (`ShapeSurfaceProps.boardStyle`); no board is rewritten.
 *
 * Kept in config.json `shapeBoardStyle` through POST /api/inbox/settings `{ shape_style }`, the way the text size
 * is: config.json wins, adopted from the first settings read and never over a choice made on this page before that
 * read answered. A cookie keeps the last style this browser showed, so a board opened before the read answers is
 * drawn in it.
 */

import { useSyncExternalStore } from 'react';
import { isShapeBoardStyle, SHAPE_BOARD_STYLE_DEFAULT, type ShapeBoardStyle } from '@plannotator/core/shape';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

export const SHAPE_STYLE_COOKIE = 'plannotator-shape-style';

let current: ShapeBoardStyle = readCookie();
let adopted = false;
let chosenHere = false;
const listeners = new Set<() => void>();

function readCookie(): ShapeBoardStyle {
  try {
    const saved = storage.getItem(SHAPE_STYLE_COOKIE);
    return isShapeBoardStyle(saved) ? saved : SHAPE_BOARD_STYLE_DEFAULT;
  } catch {
    return SHAPE_BOARD_STYLE_DEFAULT;
  }
}

function apply(style: ShapeBoardStyle): void {
  current = style;
  try {
    if (style === SHAPE_BOARD_STYLE_DEFAULT) storage.removeItem(SHAPE_STYLE_COOKIE);
    else storage.setItem(SHAPE_STYLE_COOKIE, style);
  } catch {
    // A page with no cookies still shows the style; it is only not remembered here.
  }
  for (const listener of listeners) listener();
}

/** config.json's style, from the first settings read that names one, never over a choice made on this page first. */
export function adoptSavedShapeStyle(style: unknown): void {
  if (adopted || !isShapeBoardStyle(style)) return;
  adopted = true;
  if (!chosenHere) apply(style);
}

/** The person's choice: every board shows it at once, then it is saved to config.json. */
export function chooseShapeStyle(style: ShapeBoardStyle): Promise<void> {
  chosenHere = true;
  apply(style);
  return inboxApi.saveShapeStyle(style).then(
    () => {},
    () => {},
  );
}

export function useShapeStyle(): ShapeBoardStyle {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => SHAPE_BOARD_STYLE_DEFAULT,
  );
}

/** Tests only: a fresh page, on the default, that has not read its settings. */
export function resetShapeStyleForTests(): void {
  adopted = false;
  chosenHere = false;
  apply(SHAPE_BOARD_STYLE_DEFAULT);
}
