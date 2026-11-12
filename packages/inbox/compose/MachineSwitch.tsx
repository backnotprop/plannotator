import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { isTextCut, Tip } from '../components/Tip';
import { asleepSince, fitMachineSwitch, liveCount, machineSub, type ToMachine } from './toMachines';

/** A button's natural width counts at most this much when deciding what fits: a long name is cut, not given the row. */
const NATURAL_MAX = 190;
/** The segmented control's gap between buttons, and its padding and border on both sides. */
const GAP = 2;
const FRAME = 8;

function Face({ m }: { m: ToMachine }) {
  const n = liveCount(m);
  return (
    <>
      <Icon name={m.asleep ? 'moon' : 'laptop'} size={14} />
      <span className="ib-cp-mswn" dir="auto">
        {m.name}
      </span>
      {!m.asleep && n > 0 && <span className="ib-cp-mswc">{n}</span>}
    </>
  );
}

/** The full name, cut or not, and an asleep machine's time. */
const tipOf = (m: ToMachine) => `${m.name}${m.asleep ? ` · ${asleepSince(m)}` : ''}`;

/**
 * The machine switch on a computer: one button per machine ("Lumen 2": its running agents), the chosen one filled.
 * Buttons that would be too narrow to read go under "N more", whose list names each with what runs there; this
 * computer and the chosen machine always keep theirs. A press keeps focus in the filter.
 */
export function MachineSwitch({ machines, chosen, onChoose }: { machines: readonly ToMachine[]; chosen: string; onChoose: (key: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ shown: string[]; rest: string[]; squeeze: boolean } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const faces = machines.map((m) => `${m.key}\u0000${m.name}\u0000${m.asleep}\u0000${liveCount(m)}`).join('\u0001');

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const measure = measureRef.current;
    if (!wrap || !measure) return;
    const run = () => {
      const widths = [...measure.querySelectorAll<HTMLElement>('[data-measure-machine]')].map((b) => Math.min(b.offsetWidth, NATURAL_MAX) + GAP);
      const moreWidth = (measure.querySelector<HTMLElement>('[data-measure-more]')?.offsetWidth ?? 0) + GAP;
      const next = fitMachineSwitch({ keys: machines.map((m) => m.key), widths, avail: wrap.clientWidth - FRAME, moreWidth, chosen });
      setFit((had) => (had && had.squeeze === next.squeeze && had.shown.join() === next.shown.join() ? had : next));
    };
    run();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(run);
    watch?.observe(wrap);
    return () => watch?.disconnect();
    // `faces` stands for the machines' names, states and counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faces, chosen]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [moreOpen]);

  const shown = fit ? machines.filter((m) => fit.shown.includes(m.key)) : machines;
  const rest = fit ? machines.filter((m) => fit.rest.includes(m.key)) : [];
  const choose = (key: string) => {
    setMoreOpen(false);
    onChoose(key);
  };

  return (
    <div className="ib-cp-msw" ref={wrapRef} data-compose-machines="">
      <div className="ib-seg ib-cp-mswrow" data-squeeze={fit?.squeeze ? '' : undefined}>
        {shown.map((m) => (
          <Tip key={m.key} content={tipOf(m)} when={(trigger) => m.asleep || isTextCut(trigger.querySelector('.ib-cp-mswn'))}>
            <button
              type="button"
              className="ib-seg-o ib-cp-mswb"
              aria-pressed={m.key === chosen}
              data-on={m.key === chosen ? '' : undefined}
              data-compose-switch={m.key}
              data-asleep={m.asleep ? '' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(m.key)}
            >
              <Face m={m} />
            </button>
          </Tip>
        ))}
        {rest.length > 0 && (
          <div className="ib-cp-mswmorewrap" ref={moreRef}>
            <button
              type="button"
              className="ib-seg-o ib-cp-mswb ib-cp-mswmore"
              aria-expanded={moreOpen}
              data-compose-machine-more=""
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <span className="ib-cp-mswn">{rest.length} more</span>
              <Icon name="chevD" size={13} />
            </button>
            {moreOpen && (
              <div className="ib-cp-mswpanel" data-compose-machine-panel="">
                {rest.map((m) => (
                  <button key={m.key} type="button" className="ib-cp-mswpo" data-compose-switch={m.key} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(m.key)}>
                    <Icon name={m.asleep ? 'moon' : 'laptop'} size={14} />
                    <span className="ib-cp-mswpw">
                      <span dir="auto">{m.name}</span>
                      <span className="ib-cp-mswps">{machineSub(m)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Every button at its natural width, unseen, so the switch knows what fits. */}
      <div className="ib-seg ib-cp-mswrow ib-cp-mswmeasure" ref={measureRef} aria-hidden="true">
        {machines.map((m) => (
          <span key={m.key} className="ib-seg-o ib-cp-mswb" data-measure-machine="">
            <Face m={m} />
          </span>
        ))}
        <span className="ib-seg-o ib-cp-mswb ib-cp-mswmore" data-measure-more="">
          <span className="ib-cp-mswn">{machines.length} more</span>
          <Icon name="chevD" size={13} />
        </span>
      </div>
    </div>
  );
}

/** The machine switch on a phone: chips that wrap, two to a line at most, so every machine is in sight. */
export function MachineChips({ machines, chosen, onChoose }: { machines: readonly ToMachine[]; chosen: string; onChoose: (key: string) => void }) {
  return (
    <div className="ib-cp-mchips" data-compose-machines="">
      {machines.map((m) => (
        <button
          key={m.key}
          type="button"
          className="ib-cp-mchip"
          aria-pressed={m.key === chosen}
          data-on={m.key === chosen ? '' : undefined}
          data-compose-switch={m.key}
          data-asleep={m.asleep ? '' : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(m.key)}
        >
          <Face m={m} />
        </button>
      ))}
    </div>
  );
}
