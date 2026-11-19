/**
 * @plannotator/canvas: Plannotator's own canvas.
 *
 * Four layers, each depending only on the ones above it:
 *
 *   model/     The document: typed, plain JSON, versioned. Objects, arrows,
 *              groups, frames, snapshots. Reading and checking only.
 *   events/    The only way a document changes. Commands (what someone
 *              wants) are planned into events (what happened), events are
 *              reduced into the next document, and each commit is an
 *              envelope. Undo, the agent's door and the sync seam are all
 *              that one stream.
 *   view/      What is on screen, as pure maths: the camera, the spatial
 *              index, culling, level of detail, hit-testing. No DOM.
 *   react/     The renderer (`CanvasView`: DOM, with one SVG layer for
 *              arrows) and the editor around it (`CanvasEditor`: gestures
 *              and bars).
 *
 * `snapshot/` sits on all four: a live, read-only window onto part of a
 * canvas that embeds in a plan (`SnapshotFigure`), the Markdown block that
 * refers to it (`:::canvas-snapshot`), and the motion that opens the canvas
 * from it (`CanvasStage`).
 *
 * Nothing in the product imports this package yet. `demo/` is the only
 * consumer. The guide is docs/agent-guides/canvas.md.
 */
export * from './events';
export * from './model';
export * from './react';
export * from './snapshot';
export * from './view';
