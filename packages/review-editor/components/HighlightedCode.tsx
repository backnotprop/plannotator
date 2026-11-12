import React, { useRef, useEffect } from 'react';
import { applyHighlight } from '@plannotator/ui/utils/codeHighlight';
import { useFenceTheme } from '@plannotator/ui/hooks/useFenceTheme';

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
