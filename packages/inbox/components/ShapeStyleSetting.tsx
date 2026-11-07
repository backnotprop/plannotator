/**
 * Settings → Capabilities → Shape → Board style (approval "shape-board-style-switch", the Stage take of the 2026-11-07
 * addendum): a child row of the Shape switch, shown only while Shape is on. The Rounded | Sharp segmented control
 * sits beside the title, over one wide board drawn by the board's own renderer in the picked style, so the preview is
 * what every board will look like (light, dark and every palette included). A pick shows on every board at once and
 * is saved to config.json (`shapeStyle.ts`).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ShapeBoardStyle, ShapeDrawnView } from '@plannotator/core/shape';
import { ShapeDrawn } from '@plannotator/ui/components/shape/ShapeDrawn';
import { chooseShapeStyle, useShapeStyle } from '../shapeStyle';

const SHAPE_STYLE_CHOICES = [
  { id: 'rounded', label: 'Rounded', trait: 'Bold lines, round corners, open arrowheads.' },
  { id: 'sharp', label: 'Sharp', trait: '1 px lines, small corners, filled arrowheads.' },
] as const satisfies readonly { id: ShapeBoardStyle; label: string; trait: string }[];

/**
 * The preview boards, as the kit draws them (shapeStyle.test.tsx holds both to the kit's output, so they show what a
 * new board shows): a small system on a wide canvas, and a narrower one for a phone, where the wide one would shrink
 * past reading.
 */
export const SHAPE_STYLE_PREVIEW: ShapeDrawnView = { html: '<svg viewBox="0 0 640 200" width="100%"><rect x="16" y="70" width="104" height="46" rx="8" class="line" style="fill:var(--paper)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="68" y="98" font-size="15" font-weight="500" text-anchor="middle" class="">Client</text><path d="M120 93L190 93" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M181.7 98.6L190 93L181.7 87.4" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M182.3 96.1L190 93L182.3 89.9Z" class="shp-head line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><rect x="190" y="70" width="112" height="46" rx="8" class="line" style="fill:var(--paper)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="246" y="98" font-size="15" font-weight="500" text-anchor="middle" class="">API</text><rect x="350" y="14" width="274" height="172" rx="12" style="fill:var(--green-soft)"/><text x="366" y="38" font-size="13" font-weight="600" style="fill:var(--green)">Workers · 3</text><path d="M302 84L325 84Q330 84 330 79L330 79Q330 74 335 74L372 74" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M302 84L330 84L330 74L372 74" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><path d="M363.7 79.6L372 74L363.7 68.4" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M364.3 77.1L372 74L364.3 70.9Z" class="shp-head line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><rect x="372" y="54" width="112" height="40" rx="8" class="line" style="fill:var(--paper)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="428" y="79" font-size="14" font-weight="500" text-anchor="middle" class=" t-mono">resize</text><path d="M302 104L318 104Q330 104 330 116L330 128Q330 140 342 140L372 140" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M302 104L330 104L330 140L372 140" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><path d="M363.7 145.6L372 140L363.7 134.4" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M364.3 143.1L372 140L364.3 136.9Z" class="shp-head line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><rect x="372" y="120" width="112" height="40" rx="8" class="line" style="fill:var(--paper)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="428" y="145" font-size="14" font-weight="500" text-anchor="middle" class=" t-mono">thumbnail</text><rect x="512" y="87" width="96" height="40" rx="8" class="line dash" style="fill:var(--paper)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="560" y="112" font-size="15" font-weight="500" text-anchor="middle" class="">S3</text><path d="M484 74L490 74Q496 74 496 80L496 99Q496 107 504 107L512 107" class="grey" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M484 74L496 74L496 107L512 107" class="grey" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><path d="M503.7 112.6L512 107L503.7 101.4" class="grey" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M504.3 110.1L512 107L504.3 103.9Z" class="shp-head grey" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><path d="M484 140L490 140Q496 140 496 134L496 107" class="grey" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M484 140L496 140L496 107" class="grey" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/></svg>', width: 640, height: 200 };
export const SHAPE_STYLE_PREVIEW_NARROW: ShapeDrawnView = { html: '<svg viewBox="0 0 300 150" width="100%"><rect x="150" y="12" width="138" height="126" rx="12" style="fill:var(--blue-soft)"/><text x="164" y="34" font-size="13" font-weight="600" style="fill:var(--blue)">Cache</text><rect x="14" y="52" width="92" height="40" rx="8" class="line" style="fill:var(--paper)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="60" y="77" font-size="15" font-weight="500" text-anchor="middle" class="">API</text><rect x="170" y="82" width="100" height="40" rx="8" class="line" style="fill:var(--paper)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="220" y="107" font-size="15" font-weight="500" text-anchor="middle" class="">Redis</text><path d="M106 62L122 62Q134 62 134 74L134 90Q134 102 146 102L170 102" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M106 62L134 62L134 102L170 102" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/><path d="M161.7 107.6L170 102L161.7 96.4" class="line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-round=""/><path d="M162.3 105.1L170 102L162.3 98.9Z" class="shp-head line" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" data-shp-sharp="" display="none"/></svg>', width: 300, height: 150 };
/** Below this frame width (CSS px) the narrow board is drawn. */
const NARROW_FRAME = 460;

export function ShapeStyleRow() {
  const style = useShapeStyle();
  const now = SHAPE_STYLE_CHOICES.find((c) => c.id === style)!;
  return (
    <div className="ib-prow ib-prow-child ib-bstyle" data-settings-shape-style={style}>
      <div className="ib-bstyle-head">
        <span className="ib-txt">
          <span className="ib-l" id="ib-shape-style-label">
            Board style
          </span>
          {/* Proposed copy, awaiting the owner's OK (the approved line was "Every board follows, old ones too", which old
              boards' bends and heads contradict). */}
          <span className="ib-desc">Every board follows; older ones keep their curved elbows and open arrowheads until redrawn.</span>
        </span>
        <span className="ib-ctl">
          <span className="ib-seg" role="radiogroup" aria-labelledby="ib-shape-style-label">
            {SHAPE_STYLE_CHOICES.map((choice) => (
              <label key={choice.id} className="ib-seg-o" data-on={style === choice.id ? '' : undefined} data-shape-style-choice={choice.id}>
                <input type="radio" name="ib-shape-style" value={choice.id} checked={style === choice.id} onChange={() => void chooseShapeStyle(choice.id)} />
                {choice.label}
              </label>
            ))}
          </span>
        </span>
      </div>
      <StylePreview style={style} />
      <span className="ib-bstyle-cap">{now.trait}</span>
    </div>
  );
}

/**
 * The preview, in the picked style. It picks the wide or the narrow board by its own width: a board's frame, not the
 * window, decides (`ShapeDrawn` itself switches to a board's tall view under 700 px of frame, which a desktop
 * Settings card already is, so the narrow board is a canvas of its own, not a tall view).
 */
function StylePreview({ style }: { style: ShapeBoardStyle }) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < NARROW_FRAME);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="ib-bstyle-pic" data-narrow={narrow ? '' : undefined} aria-hidden="true">
      <ShapeDrawn drawn={narrow ? SHAPE_STYLE_PREVIEW_NARROW : SHAPE_STYLE_PREVIEW} phase="drawn" reduce boardStyle={style} />
    </div>
  );
}
