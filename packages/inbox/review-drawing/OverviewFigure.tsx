/**
 * The Overview's picture (mock ac2, "How it works"): the agent's own drawing,
 * sent with the guide (`overview.diagram`, kind html), drawn inline with
 * Shape's `ShapeDiagram`. A click on a part opens its code. In a later round
 * whose agent redrew it, the parts that changed redraw and keep a "changed"
 * tag. A review with no picture gets one Show me in its heading, which asks
 * for a picture of the whole review.
 */
import { useState } from 'react';
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

/** A review that came with no picture: Show me, one of the review's own actions in its heading, asks the agent for one of the whole review. */
export function ShowMeButton({ onShowMe }: { onShowMe: () => void }) {
  return (
    <button type="button" className="ib-btn ib-pri ib-sm-send gv-head-showme" onClick={onShowMe} data-overview-show-me="" data-overview-show-me-button="">
      <Pebble alive={false} size={14} className="ib-sm-peb" />
      Show me
    </button>
  );
}
