import { createContext, useContext, useMemo } from 'react';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';

/**
 * A host's decision on a diagram fence by its source, made before any engine work: `kind` is the fence's diagram kind
 * (`'mermaid'`, or `'graphviz'` for a dot / graphviz fence) and `source` the fence's text as written, before any
 * rewriting Plannotator does for an engine. Only `true` lets the fence be drawn.
 */
export type DiagramSourceAccept = (kind: DiagramKind, source: string) => boolean;

/**
 * Opt-in: a host's check of every diagram fence's SOURCE before either engine runs (no engine is loaded, nothing is
 * parsed or drawn, for a refused fence). Refused, the block shows its source as code, exactly as a
 * `DiagramSvgAcceptContext` refusal does. Asked synchronously, once per (kind, source) for a given function, so pass a
 * stable function (module-level or memoised). A check that throws, or returns anything but `true`, refuses. Absent
 * (null), every diagram renders exactly as before. Its own small module, so a host can provide it without importing
 * the diagram engine.
 */
export const DiagramSourceAcceptContext = createContext<DiagramSourceAccept | null>(null);

/** The host's verdict on one source: `true` with no check; a check that throws or answers anything but `true` refuses. */
export function diagramSourceAccepted(check: DiagramSourceAccept | null, kind: DiagramKind, source: string): boolean {
  if (check === null) return true;
  try {
    return check(kind, source) === true;
  } catch (error) {
    console.warn('[plannotator] The host diagram source check threw; the diagram is shown as its source.', error);
    return false;
  }
}

/** `diagramSourceAccepted` with the context's check, asked again only when the check, the kind or the source changes. */
export function useDiagramSourceAccepted(kind: DiagramKind, source: string): boolean {
  const check = useContext(DiagramSourceAcceptContext);
  return useMemo(() => diagramSourceAccepted(check, kind, source), [check, kind, source]);
}
