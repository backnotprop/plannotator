/**
 * The diagram engine's host surface (0.41.0): the one viewer over the
 * renderer slot, its canvas, overlay, composer and Source pane, and the
 * hooks and types a host wires them with. The renderer slot itself, the
 * runtime slots and the anchor codecs live under `utils/` (`diagram-render`,
 * `graphviz`, `mermaid`, `diagram-anchor`, `diagram-anchor-graphviz`,
 * `diagram-projection`).
 */
export { DiagramViewer, type DiagramViewerProps } from './DiagramViewer';
export { DiagramPopout } from './DiagramPopout';
export { DiagramCanvas, svgContentSize, KEY_PAN_PX, type DiagramCanvasHandle, type DiagramEscapeOutcome } from './DiagramCanvas';
export { DiagramOverlay } from './DiagramOverlay';
export { DiagramComposer } from './DiagramComposer';
export { DiagramSourcePane } from './DiagramSourcePane';
export {
  useDiagramComments,
  type DiagramComment,
  type DiagramComposerDraft,
  type DiagramCreateComment,
  type DiagramHover,
  type ResolvedDiagramComment,
} from './useDiagramComments';
export { useDiagramRender, type DiagramRenderState } from './useDiagramRender';
export { useDiagramSourceDraft, PREVIEW_DEBOUNCE_MS, type DiagramSourceDraft, type SaveResult } from './useDiagramSourceDraft';
export {
  useDiagramViewport,
  DRAG_THRESHOLD_PX,
  TOUCH_DRAG_THRESHOLD_PX,
  FIT_PADDING_PX,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  type ContentSize,
  type Viewport,
} from './useDiagramViewport';
