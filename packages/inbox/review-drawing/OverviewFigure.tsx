/**
 * The Overview's picture (mock ac2, "How it works"): the agent's own drawing,
 * sent with the guide (`overview.diagram`, kind html), drawn inline with
 * Shape's `ShapeDiagram`. A click on a part opens its code. In a later round
 * whose agent redrew it, the parts that changed redraw and keep a "changed"
 * tag. A review with no picture gets one Show me in its heading, which asks
 * for a picture of the whole review.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ShapeCodeTarget, ShapeDrawnView } from '@plannotator/core/shape';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { ShapeDiagram, type MarkState } from '@plannotator/ui/components/shape/ShapeDrawn';

const EMPTY = new Set<string>();

export function OverviewFigure({
  drawn,
  meta,
  changed,
  onCode,
}: {
  drawn: ShapeDrawnView;
  /** "drawn by Claude Code with the guide", or the round's redraw line. */
  meta: string;
  /** Parts redrawn since the earlier round (`data-mark` ids). */
  changed?: ReadonlySet<string>;
  onCode: (target: ShapeCodeTarget, el: HTMLElement) => void;
}) {
  const [hidden, setHidden] = useState(false);
  const marks: MarkState | undefined = changed?.size ? { fresh: changed, erasing: EMPTY, noted: EMPTY } : undefined;
  return (
    <section className="ib-ov-fig" aria-label="How it works" data-overview-figure={hidden ? 'hidden' : 'shown'}>
      <div className="ib-ov-fig-h">
        <Pebble alive={false} size={16} className="ib-sm-peb" />
        <b>How it works</b>
        <span className="ib-ov-fig-m">· {meta}</span>
        <span className="ib-sp" />
        <button type="button" className="ib-btn ib-sm-quiet" onClick={() => setHidden((was) => !was)} aria-expanded={!hidden}>
          {hidden ? 'Show' : 'Hide'}
        </button>
      </div>
      {!hidden && (
        <>
          <div className="ib-ov-fig-b">
            <ShapeDiagram drawn={drawn} onCode={onCode} {...(marks ? { marks, tags: { fresh: 'changed' } } : {})} />
          </div>
          <div className="ib-ov-fig-f">Click a part to open its code</div>
        </>
      )}
    </section>
  );
}

/** The tallest a chapter's picture draws inline, as a chapter's Mermaid diagram (GuideSectionCard). */
const CHAPTER_PICTURE_MAX_HEIGHT = 320;

/**
 * A chapter's drawn picture (format version 5, kind html), at the top of the chapter's code pane under the guide's
 * folding "Diagram" header, so it has no Hide of its own. The wide drawing scales to fit the pane's width and at
 * most 320px of height, as a chapter's Mermaid diagram does; Expand opens it full size over the review. The tall
 * layout an agent may add for a narrow pane flows as HTML, not a scaled canvas, so it keeps its own height there.
 */
export function ChapterFigure({ drawn, meta, onCode }: { drawn: ShapeDrawnView; meta: string; onCode: (target: ShapeCodeTarget, el: HTMLElement) => void }) {
  const [expanded, setExpanded] = useState(false);
  const capped = drawn.width !== undefined && drawn.height !== undefined;
  return (
    <section className="ib-ov-fig ib-ch-fig" aria-label="Chapter picture" data-chapter-figure="">
      <div className="ib-ov-fig-h">
        <Pebble alive={false} size={16} className="ib-sm-peb" />
        <span className="ib-ov-fig-m">{meta}</span>
        <span className="ib-sp" />
        <button type="button" className="ib-btn ib-sm-quiet" onClick={() => setExpanded(true)} data-chapter-figure-expand="">
          Expand
        </button>
      </div>
      <div className="ib-ov-fig-b">
        {/* The box keeps the drawing's aspect up to 320px tall; ShapeDrawn fits the canvas inside it (inbox.css). */}
        <div className="ib-ch-fig-box" style={capped ? { aspectRatio: `${drawn.width} / ${drawn.height}`, maxHeight: CHAPTER_PICTURE_MAX_HEIGHT } : undefined}>
          <ShapeDiagram drawn={drawn} onCode={onCode} />
        </div>
      </div>
      <div className="ib-ov-fig-f">Click a part to open its code</div>
      {expanded && <ChapterFigurePopout drawn={drawn} onCode={onCode} onClose={() => setExpanded(false)} />}
    </section>
  );
}

/** The chapter's picture full size over the review: the drawing fits the window; a part still opens its code. */
function ChapterFigurePopout({ drawn, onCode, onClose }: { drawn: ShapeDrawnView; onCode: (target: ShapeCodeTarget, el: HTMLElement) => void; onClose: () => void }) {
  useEffect(() => {
    // As the Mermaid popout: Escape closes it (no new Inbox key; it acts only while the picture is open).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="ib-ch-fig-pop" data-popover-layer="" data-chapter-figure-popout="" onClick={onClose}>
      <div className="ib-ch-fig-pop-in" role="dialog" aria-modal="true" aria-label="Chapter picture" onClick={(event) => event.stopPropagation()}>
        <div className="ib-ov-fig-h">
          <b>Chapter picture</b>
          <span className="ib-sp" />
          <button type="button" className="ib-btn ib-sm-quiet" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <div className="ib-ch-fig-pop-b">
          <ShapeDiagram
            drawn={drawn}
            onCode={(target, el) => {
              onClose();
              onCode(target, el);
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A review that came with no picture: Show me, one of the review's own actions in its heading, asks the agent for one of the whole review. */
export function ShowMeButton({ onShowMe }: { onShowMe: () => void }) {
  return (
    <button type="button" className="ib-btn ib-pri ib-sm-send gv-head-showme" onClick={onShowMe} data-overview-show-me="" data-overview-show-me-button="">
      <Pebble alive={false} size={14} className="ib-sm-peb" />
      Show me
    </button>
  );
}
