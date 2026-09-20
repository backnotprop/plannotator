import { useEffect, useState } from 'react';
import {
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
  } | null;
  readonly pending: boolean;
}

let renderCounter = 0;

/**
 * Render `source` through the renderer slot whenever it, the kind, the
 * theme or `retryToken` changes. Each render gets its own id
 * (`diagram-<documentId>-<n>`): Mermaid removes any existing element with
 * the id it is asked to render into, so reusing one id would tear the
 * displayed svg out of the page mid-render.
 */
export function useDiagramRender(
  kind: DiagramKind,
  documentId: string,
  source: string,
  theme: DiagramTheme,
  options?: { readonly retryToken?: number },
): DiagramRenderState {
  const retryToken = options?.retryToken ?? 0;
  const [state, setState] = useState<DiagramRenderState>({
    svgNode: null,
    renderId: null,
    renderVersion: 0,
    error: null,
    pending: true,
  });

  useEffect(() => {
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
    void renderDiagram(kind, renderId, source, theme).then((result: DiagramRenderResult) => {
      if (cancelled) return;
      if (isRenderError(result)) {
        const error = { message: result.message, line: result.line, runtimeUnavailable: result.runtimeUnavailable };
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
  }, [documentId, kind, source, theme, retryToken]);

  return state;
}
