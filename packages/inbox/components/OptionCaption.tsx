import { useEffect, useRef, useState } from 'react';
import type { OptionSetChoice, OptionSet } from '../optionSets';
import { Icon } from '../icons';

export function OptionCaption({ set, index, phone = false, onStep }: { set: OptionSet; index: number; phone?: boolean; onStep?: (dir: 1 | -1) => void }) {
  const choice = set.choices[index];
  const card = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLElement>(null);
  const [tip, setTip] = useState(false);

  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const stage = el.closest('.ib-view')?.querySelector('[data-image-zoom-stage]');
      stage?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          clientX: event.clientX,
          clientY: event.clientY,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    const onGesture = (event: Event) => event.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(type, onGesture, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(type, onGesture);
    };
  }, []);

  useEffect(() => {
    setTip(false);
    const onMove = (event: PointerEvent) => {
      const el = label.current;
      if (!el || event.pointerType !== 'mouse') return setTip(false);
      const r = el.getBoundingClientRect();
      const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      setTip(inside && el.scrollWidth > el.clientWidth);
    };
    const off = () => setTip(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', off);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', off);
    };
  }, [index]);

  if (!choice) return null;
  const prev = set.choices[index - 1];
  const next = set.choices[index + 1];
  const arrow = (dir: 1 | -1, to: OptionSetChoice | undefined) => (
    <button
      type="button"
      className="ib-optcap-step"
      aria-label={to ? `${dir < 0 ? 'Previous' : 'Next'} option: ${to.label}` : `${dir < 0 ? 'Previous' : 'Next'} option: this is the ${dir < 0 ? 'first' : 'last'}`}
      aria-disabled={to ? undefined : true}
      onClick={() => to && onStep?.(dir)}
      data-option-step={dir < 0 ? 'prev' : 'next'}
    >
      <Icon name={dir < 0 ? 'chevL' : 'chevR'} size={15} />
    </button>
  );
  const row = (c: OptionSetChoice, spacer: boolean) => (
    <>
      {!c.lettered && (
        <span className="ib-optcap-letter" aria-hidden="true">
          {spacer ? '' : c.letter}
        </span>
      )}
      <b className="ib-optcap-label" ref={spacer ? undefined : label}>
        {!spacer && !c.lettered && <span className="sr-only">{`Option ${c.letter}: `}</span>}
        {c.label}
      </b>
      {c.recommended && (
        <span className="ib-optcap-rec" data-option-recommended={spacer ? undefined : ''}>
          Recommended
        </span>
      )}
    </>
  );
  return (
    <div className="ib-optcap" ref={card} data-option-caption={choice.letter}>
      {!phone && arrow(-1, prev)}
      <div className="ib-optcap-body">
        <div className="ib-optcap-main">{row(choice, false)}</div>
        {set.choices.map((c) => (
          <div key={c.choice} className="ib-optcap-size" aria-hidden="true">
            {row(c, true)}
          </div>
        ))}
      </div>
      {!phone && arrow(1, next)}
      {tip && (
        <span className="ib-optcap-tip" aria-hidden="true">
          {choice.label}
        </span>
      )}
    </div>
  );
}
