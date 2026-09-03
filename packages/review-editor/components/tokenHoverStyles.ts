import type { CSSProperties } from 'react';

/**
 * The hovered-token treatment, defined ONCE.
 *
 * The diff pane renders inside Pierre's shadow root, so its copy has to be
 * serialized into that stylesheet as `.pn-token-hover`; the announcement
 * dialog's example lives in the ordinary document and applies the same
 * declarations as a style object. Two consumers, one definition, so the
 * example cannot drift away from the surface it is illustrating.
 */
const UNDERLINE: { textDecorationThickness: string; textUnderlineOffset: string } = {
  textDecorationThickness: '1.5px',
  textUnderlineOffset: '2px',
};

/**
 * The shadow-DOM form. `primaryColor` is the resolved theme primary, because a
 * `var(--primary)` reference does not cross into Pierre's shadow root.
 */
export function tokenHoverUnderlineCss(primaryColor: string): string {
  return `
            text-decoration: underline;
            text-decoration-color: ${primaryColor};
            text-decoration-thickness: ${UNDERLINE.textDecorationThickness};
            text-underline-offset: ${UNDERLINE.textUnderlineOffset};
            cursor: pointer !important;`;
}

/**
 * The main-document form, for the announcement dialog's example. Same
 * declarations; the decoration color resolves through the theme token, which
 * is available here and is what `primaryColor` above is resolved FROM.
 */
export const TOKEN_HOVER_UNDERLINE_STYLE: CSSProperties = {
  textDecorationLine: 'underline',
  textDecorationColor: 'var(--primary)',
  textDecorationThickness: UNDERLINE.textDecorationThickness,
  textUnderlineOffset: UNDERLINE.textUnderlineOffset,
  cursor: 'pointer',
};
