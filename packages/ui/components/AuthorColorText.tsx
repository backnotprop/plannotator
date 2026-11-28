import React, { useLayoutEffect, useRef } from 'react';
import type { AuthorColor } from '../utils/authorColor';
import { watchAuthorColor } from '../utils/authorColorContrast';

/**
 * Words the author coloured (`<span style="color: …">` / `<font color>` in
 * inline markdown). Only a `<span>` with a colour, so the text, its offsets
 * and every annotation over it are those of the uncoloured words.
 */
export const AuthorColorText: React.FC<{ color: AuthorColor; children: React.ReactNode }> = ({ color, children }) => {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watchAuthorColor(el, color);
    // `color` is a new object every render; its css is what identifies it.
  }, [color.css]);
  return <span ref={ref} style={{ color: color.css }}>{children}</span>;
};
