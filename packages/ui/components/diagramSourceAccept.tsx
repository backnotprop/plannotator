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
 * `DiagramSvgAcceptContext` refusal does, whatever was drawn before. Asked synchronously; the answer is kept only while
 * that diagram stays mounted with the same function, kind and source, so pass a stable function (module-level or
 * memoised), a NEW function when the policy changes, and decide only what you would decide again at any remount. A
 * check that throws, or returns anything but `true`, refuses. Absent (null), every diagram renders exactly as before:
 * a host that loads its policy later passes a function that refuses until then, never null. Its own small module, so a
 * host can provide it without importing the diagram engine.
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

/** One mounted block's answer, and what it was asked with. */
export interface DiagramSourceVerdict {
  readonly check: DiagramSourceAccept | null;
  readonly kind: DiagramKind;
  readonly source: string;
  readonly accepted: boolean;
}

/**
 * @internal A diagram block hands its own answer to the viewers inside it (inline and pop-out), so the host is asked
 * once per mounted block. Scoped to that block's subtree and kept no longer than it is mounted; a viewer uses it only
 * when it was asked with the same check function, kind and source, and asks for itself otherwise.
 */
export const DiagramSourceVerdictContext = createContext<DiagramSourceVerdict | null>(null);

/** The context's check on one source, asked again only when the check, the kind or the source changes, or on a remount
 * (nothing outlives the component); an enclosing block's answer for the same three is used instead of asking. */
export function useDiagramSourceVerdict(kind: DiagramKind, source: string): DiagramSourceVerdict {
  const check = useContext(DiagramSourceAcceptContext);
  const enclosing = useContext(DiagramSourceVerdictContext);
  return useMemo(() => {
    if (enclosing !== null && enclosing.check === check && enclosing.kind === kind && enclosing.source === source) return enclosing;
    return { check, kind, source, accepted: diagramSourceAccepted(check, kind, source) };
  }, [enclosing, check, kind, source]);
}

/** `useDiagramSourceVerdict`'s answer alone. */
export function useDiagramSourceAccepted(kind: DiagramKind, source: string): boolean {
  return useDiagramSourceVerdict(kind, source).accepted;
}
