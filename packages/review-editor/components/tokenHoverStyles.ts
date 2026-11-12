import type { CSSProperties } from 'react';

const UNDERLINE = {
  textDecorationLine: 'underline',
  textDecorationThickness: '1.5px',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
} as const;

export function tokenHoverUnderlineCss(primaryColor: string): string {
  return `
            text-decoration: ${UNDERLINE.textDecorationLine};
            text-decoration-color: ${primaryColor};
            text-decoration-thickness: ${UNDERLINE.textDecorationThickness};
            text-underline-offset: ${UNDERLINE.textUnderlineOffset};
            cursor: ${UNDERLINE.cursor} !important;`;
}

export const TOKEN_HOVER_UNDERLINE_STYLE: CSSProperties = {
  ...UNDERLINE,
  textDecorationColor: 'var(--primary)',
};
