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
 * `DiagramSvgAcceptContext` refusal does, whatever was drawn before. Asked synchronously, once per (kind, source) for a
 * given function, so pass a stable function (module-level or memoised), and a NEW function when the policy changes. A
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

/** The most answers kept per check function; past it the oldest is asked again when it comes back. */
const REMEMBERED_PER_CHECK = 256;
const remembered = new WeakMap<DiagramSourceAccept, Map<string, boolean>>();

/** `diagramSourceAccepted`, remembered per check function, kind and source, so every part of one block (the inline
 * viewer, its pop-out, the block's own controls) gets the same answer from one call. */
function rememberedVerdict(check: DiagramSourceAccept | null, kind: DiagramKind, source: string): boolean {
  if (check === null) return true;
  const key = `${kind}\u0000${source}`;
  let verdicts = remembered.get(check);
  const known = verdicts?.get(key);
  if (known !== undefined) return known;
  const verdict = diagramSourceAccepted(check, kind, source);
  if (verdicts === undefined) {
    verdicts = new Map();
    remembered.set(check, verdicts);
  }
  if (verdicts.size >= REMEMBERED_PER_CHECK) {
    const oldest = verdicts.keys().next();
    if (!oldest.done) verdicts.delete(oldest.value);
  }
  verdicts.set(key, verdict);
  return verdict;
}

/** The context's check on one source, asked once per check function, kind and source (a new function is asked again). */
export function useDiagramSourceAccepted(kind: DiagramKind, source: string): boolean {
  const check = useContext(DiagramSourceAcceptContext);
  return useMemo(() => rememberedVerdict(check, kind, source), [check, kind, source]);
}
