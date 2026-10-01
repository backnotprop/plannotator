import type { CSSProperties } from 'react';

type DocumentTypographyVariables = CSSProperties & {
  '--plannotator-document-font-family'?: string;
  '--plannotator-document-font-scale'?: number;
};

/** Variables alone do not style chrome, code or diagrams; prose opts in. */
export function documentTypographyStyle(
  enabled: boolean,
  family: string,
  size: number | null,
): DocumentTypographyVariables | undefined {
  const fontName = family.trim();
  if (!enabled || (!fontName && size === null)) return undefined;
  const quotedFont = fontName.replace(/["\\\u0000-\u001f\u007f]/g, character =>
    character === '"' || character === '\\' ? `\\${character}` : `\\${character.charCodeAt(0).toString(16)} `,
  );

  return {
    '--plannotator-document-font-family': fontName ? `"${quotedFont}", var(--font-sans, sans-serif)` : undefined,
    '--plannotator-document-font-scale': size === null ? undefined : size / 15,
  };
}
