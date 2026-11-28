import { useContext, useEffect, useState } from 'react';
import { DiagramSvgAcceptContext } from '../diagramSvgAccept';
import { useDiagramSourceAccepted } from '../diagramSourceAccept';
import {
  DIAGRAM_REFUSED_RESULT,
  renderDiagram,
  type DiagramKind,
  type DiagramRenderError,
  type DiagramRenderResult,
  type DiagramTheme,
} from '../../utils/diagram-render';

function isRenderError(result: DiagramRenderResult): result is DiagramRenderError {
  return result.ok === false;
}

export interface DiagramRenderState {
  /** The last GOOD render's sanitized svg root, kept (dimmed) under a
   * parse error. The hook never holds markup: the render slot sanitizes
   * into a node and the canvas mounts it. */
  readonly svgNode: SVGSVGElement | null;
  /** The render id the current svg was rendered with (the id prefix the
   * anchor finder strips). */
  readonly renderId: string | null;
  /** Increments per successful render: the overlay re-resolves elements. */
  readonly renderVersion: number;
  readonly error: {
    readonly message: string;
    readonly line: number | null;
    /** The engine could not be loaded: a Retry can change this one. */
    readonly runtimeUnavailable: boolean;
    /** A diagram-type chunk did not load: the block offers Reload. */
    readonly chunkFailed?: boolean;
    /** The host's check refused the source (`DiagramSourceAcceptContext`) or the drawn svg (`DiagramSvgAcceptContext`): the block shows the source. */
    readonly refused?: boolean;
  } | null;
  readonly pending: boolean;
}

let renderCounter = 0;

/** What a refused source shows, whatever was drawn before: no drawing, nothing pending, the `refused` error. */
const SOURCE_REFUSED_STATE: DiagramRenderState = Object.freeze({
  svgNode: null,
  renderId: null,
  renderVersion: 0,
  error: Object.freeze({ message: DIAGRAM_REFUSED_RESULT.message, line: null, runtimeUnavailable: false, refused: true }),
  pending: false,
});

/**
 * Render `source` through the renderer slot whenever it, the kind, the
 * theme or `retryToken` changes. Each render gets its own id
 * (`diagram-<documentId>-<n>`): Mermaid removes any existing element with
 * the id it is asked to render into, so reusing one id would tear the
 * displayed svg out of the page mid-render.
 *
 * A host's source check (`DiagramSourceAcceptContext`) is asked first, once per
 * source: a refused source never reaches `renderDiagram`, so no engine is
 * loaded and nothing is parsed or drawn; the result is the same `refused` an
 * `accept` refusal gives. A source refused after an accepted one (edited in
 * place, or a stricter check) drops the previous drawing at once rather than
 * keeping it as a parse error does: the state is exactly a fresh refusal's.
 */
export function useDiagramRender(
  kind: DiagramKind,
  documentId: string,
  source: string,
  theme: DiagramTheme,
  options?: { readonly retryToken?: number },
): DiagramRenderState {
  const retryToken = options?.retryToken ?? 0;
  const accept = useContext(DiagramSvgAcceptContext);
  const sourceAccepted = useDiagramSourceAccepted(kind, source);
  const [state, setState] = useState<DiagramRenderState>({
    svgNode: null,
    renderId: null,
    renderVersion: 0,
    error: null,
    pending: true,
  });

  useEffect(() => {
    if (!sourceAccepted) {
      // The previous drawing goes: accepted again later, the fence starts over as on a first render.
      setState((current) =>
        current.svgNode === null && current.error === null && current.pending
          ? current
          : { svgNode: null, renderId: null, renderVersion: current.renderVersion, error: null, pending: true },
      );
      return;
    }
    let cancelled = false;
    renderCounter += 1;
    const renderId = `diagram-${documentId.replace(/[^\w-]/gu, '')}-${renderCounter}`;
    // A new attempt after a failed engine load (a Retry) shows the pending
    // state again rather than the stale error; a parse error stays on
    // screen until the new result lands, so a typing burst does not blink.
    setState((current) => {
      const error = current.error?.runtimeUnavailable ? null : current.error;
      return current.pending && error === current.error ? current : { ...current, error, pending: true };
    });
    void renderDiagram(kind, renderId, source, theme, accept ? { accept } : undefined).then((result: DiagramRenderResult) => {
      if (cancelled) return;
      if (isRenderError(result)) {
        const error = {
          message: result.message,
          line: result.line,
          runtimeUnavailable: result.runtimeUnavailable,
          ...(result.chunkFailed ? { chunkFailed: true } : {}),
          ...(result.refused ? { refused: true } : {}),
        };
        setState((current) => ({ ...current, error, pending: false }));
        return;
      }
      const svgNode = result.svgNode;
      setState((current) => ({
        svgNode,
        renderId,
        renderVersion: current.renderVersion + 1,
        error: null,
        pending: false,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [documentId, kind, source, theme, retryToken, accept, sourceAccepted]);

  // Synchronous, so not one frame shows the previous drawing under a refusal.
  return sourceAccepted ? state : SOURCE_REFUSED_STATE;
}
