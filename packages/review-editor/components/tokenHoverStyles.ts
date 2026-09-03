import type { CSSProperties } from 'react';

/**
 * The hovered-token treatment, for the two places it has to exist.
 *
 * The diff pane renders inside Pierre's shadow root, so its copy has to be
 * serialized into that stylesheet as `.pn-token-hover`; the announcement
 * dialog's example lives in the ordinary document and applies a style object.
 * Everything that decides how the treatment LOOKS is single-sourced in
 * `UNDERLINE` below and read by both forms, so the example cannot drift away
 * from the surface it is illustrating.
 *
 * Exactly two things are per-form, and neither is a look:
 *  - the decoration COLOR. Both mean the theme primary, but `var(--primary)`
 *    does not cross into Pierre's shadow root, so that form takes the already
 *    resolved value as an argument instead.
 *  - `!important` on the cursor, which the shadow form appends at its own call
 *    site. Pierre's `[data-*]` selectors outrank a bare class in there and the
 *    I-beam would otherwise win; in the ordinary document a style object
 *    already wins, and forcing it would be noise.
 */
const UNDERLINE = {
  textDecorationLine: 'underline',
  textDecorationThickness: '1.5px',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
} as const;

/**
 * The shadow-DOM form. `primaryColor` is the resolved theme primary; see the
 * note above on why it is passed rather than referenced.
 */
export function tokenHoverUnderlineCss(primaryColor: string): string {
  return `
            text-decoration: ${UNDERLINE.textDecorationLine};
            text-decoration-color: ${primaryColor};
            text-decoration-thickness: ${UNDERLINE.textDecorationThickness};
            text-underline-offset: ${UNDERLINE.textUnderlineOffset};
            cursor: ${UNDERLINE.cursor} !important;`;
}

/** The main-document form, for the announcement dialog's example. */
export const TOKEN_HOVER_UNDERLINE_STYLE: CSSProperties = {
  ...UNDERLINE,
  textDecorationColor: 'var(--primary)',
};
