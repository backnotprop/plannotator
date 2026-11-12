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
  meta: string;
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

const CHAPTER_PICTURE_MAX_HEIGHT = 320;

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
        <div className="ib-ch-fig-box" style={capped ? { aspectRatio: `${drawn.width} / ${drawn.height}`, maxHeight: CHAPTER_PICTURE_MAX_HEIGHT } : undefined}>
          <ShapeDiagram drawn={drawn} onCode={onCode} />
        </div>
      </div>
      <div className="ib-ov-fig-f">Click a part to open its code</div>
      {expanded && <ChapterFigurePopout drawn={drawn} onCode={onCode} onClose={() => setExpanded(false)} />}
    </section>
  );
}

function ChapterFigurePopout({ drawn, onCode, onClose }: { drawn: ShapeDrawnView; onCode: (target: ShapeCodeTarget, el: HTMLElement) => void; onClose: () => void }) {
  useEffect(() => {
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

export function ShowMeButton({ onShowMe }: { onShowMe: () => void }) {
  return (
    <button type="button" className="ib-btn ib-pri ib-sm-send gv-head-showme" onClick={onShowMe} data-overview-show-me="" data-overview-show-me-button="">
      <Pebble alive={false} size={14} className="ib-sm-peb" />
      Show me
    </button>
  );
}
