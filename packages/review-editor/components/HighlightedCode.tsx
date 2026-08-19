import React, { useRef, useEffect } from 'react';
import { applyHighlight } from '@plannotator/ui/utils/codeHighlight';
import { useFenceTheme } from '@plannotator/ui/hooks/useFenceTheme';

/**
 * A single highlighted code element, rendered by the same Shiki instance and in
 * the same resolved theme as the diff pane next to it.
 *
 * `language` comes from the caller's file path (`detectLanguage`) — there is no
 * auto-detection, so a snippet whose file type we do not recognise renders as
 * plain text rather than being guessed at.
 */
export const HighlightedCode: React.FC<{ code: string; language?: string }> = ({ code, language }) => {
  const codeRef = useRef<HTMLElement>(null);
  const fenceTheme = useFenceTheme();

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.className = language ? `language-${language}` : '';
      applyHighlight(codeRef.current, code, language, fenceTheme);
    }
  }, [code, language, fenceTheme]);

  return <code ref={codeRef}>{code}</code>;
};
