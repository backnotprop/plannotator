# Zoomable diagram shell

For the visual-explainer path only: standalone deliverables that render a zoomable Mermaid
diagram with `- / + / Reset / Expand` controls, a zoom label, and a `Figure N` caption below
the viewport. Plans and PR explainers render inside Plannotator's own diagram blocks and do
not need this.

Copy the skeleton below; do not hand-roll a new shell. #1546 was a hand-rolled shell whose
zoomed diagram painted over its own caption.

## Clipping contract (hard rules)

1. The viewport is the positioned clip container: `position: relative`,
   `overflow: hidden`, and a fixed `height`. Both declarations are load-bearing.
2. The canvas is `position: absolute; top: 0; left: 0` as a direct child of the
   viewport — never a sibling of it, never anywhere else.
3. Zoom resizes the SVG in pixels and translates the canvas; pan translates the
   canvas. The shell's layout height never changes with zoom (only the Expand
   toggle changes the viewport height, and it re-fits afterwards).
4. The `figcaption` sits in normal flow directly below the wrap. Controls and
   the zoom label are absolutely positioned inside the wrap, above the canvas.
5. Why rule 1 exists: an absolutely-positioned canvas is clipped only by
   ancestors up to and including its containing block. With a static viewport
   the canvas positions against the wrap, the viewport's `overflow: hidden`
   never applies, and the zoomed diagram paints over the caption. Positioning
   the viewport makes it the containing block, so the clip holds at any zoom.

## Skeleton

```html
<figure class="diagram-shell">
  <div class="mermaid-wrap">
    <div class="zoom-controls">
      <button data-z="out" aria-label="Zoom out">−</button>
      <button data-z="in" aria-label="Zoom in">+</button>
      <button data-z="reset" aria-label="Reset zoom">Reset</button>
      <button data-z="expand" aria-label="Toggle expanded height">Expand</button>
    </div>
    <div class="mermaid-viewport">
      <div class="mermaid-canvas">
        <pre class="diagram-source">flowchart TD
  A --> B</pre>
      </div>
    </div>
    <span class="zoom-label">100% — contain</span>
  </div>
  <figcaption><b>Figure 1 — Title.</b> Caption text.</figcaption>
</figure>
```

```css
.diagram-shell {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
  margin: 18px 0;
}
.mermaid-wrap {
  position: relative;
}
.mermaid-viewport {
  position: relative;
  height: 460px;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.mermaid-canvas {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.mermaid-canvas svg {
  display: block;
  max-width: none;
}
.zoom-controls {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 6px;
  z-index: 5;
}
.zoom-label {
  position: absolute;
  bottom: 10px;
  left: 12px;
  z-index: 5;
}
figcaption {
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  font-size: 0.82rem;
  color: var(--muted-foreground);
}
.diagram-source {
  display: none;
}
```

Zoom/pan behavior: render the Mermaid SVG into the canvas, then `fit()` scales it
to the viewport with padding and centers it. Zoom buttons, wheel, and pinch call
`zoomAround(factor, cx, cy)` toward the pointer; drag pans; all three set a
`custom` mode and re-apply `svg.style.width/height` plus
`canvas.style.transform = translate(panX, panY)`, with pan constrained so the
diagram always covers the viewport (center it when it is smaller). Reset re-fits;
Expand toggles the viewport height between the default and expanded values and
re-fits. Never grow layout height with zoom, and never let the canvas escape the
viewport element.

## Self-check (delivery gate)

Before opening the annotation UI, in both palettes: zoom to the maximum, pan to
all four extremes, and toggle Expand. The figure caption must stay fully legible
throughout — no diagram node or edge may paint over caption text — and nothing
may paint past the shell's rounded border.
