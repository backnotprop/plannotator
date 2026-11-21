/**
 * Plans' get-started screen (approval "inbox-plans", the mix: the first time, before any plan is here, and from
 * "New plan" once there are plans): the dithered field, a mono eyebrow, "What do you want to plan?" and the one
 * action. Starting an agent in plan mode from here (the mock's box) needs words agents read, not approved yet; so the
 * action says how a plan arrives today: your agent's plan review lands it here.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { startPlansDither } from './dither';

export function PlansGetStarted({ onBack, importing, note }: { onBack?: () => void; importing?: boolean; note?: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  useEffect(() => {
    if (!host.current || !canvas.current) return;
    return startPlansDither(host.current, canvas.current, () => (words.current ? [words.current] : []));
  }, []);
  return (
    <section className="ib-dpage ib-plans ib-plans-start" aria-labelledby={`${stepsId}-h`} data-plans-start="">
      <div className="ib-plans-field" ref={host} aria-hidden="true">
        <canvas ref={canvas} />
      </div>
      <div className="ib-dh ib-plans-starthead">
        <SidebarTrigger />
        {onBack && (
          <button type="button" className="ib-plans-back" onClick={onBack} data-plans-back="">
            <Icon name="chevL" />
            Spaces
          </button>
        )}
      </div>
      <div className="ib-plans-words" ref={words}>
        <p className="ib-plans-eyebrow">Plannotator Spaces</p>
        <h1 id={`${stepsId}-h`} tabIndex={-1}>
          What do you want to plan?
        </h1>
        <p className="ib-plans-lede">Plan in your agent as usual. Every plan you review is kept here, on this computer, with each version, its files and your decision.</p>
        <button type="button" className="ib-plans-primary" aria-expanded={open} aria-controls={stepsId} onClick={() => setOpen((v) => !v)} data-plans-how="">
          <Icon name="arrowRight" />
          Start a plan
        </button>
        <ol id={stepsId} className="ib-plans-steps" hidden={!open} data-plans-steps="">
          <li>Ask your agent to plan the change in plan mode.</li>
          <li>Plannotator opens the plan for your review, as it does now.</li>
          <li>Approve it or ask for changes. The plan, each new version and your decision show up here.</li>
        </ol>
        {importing && (
          <p className="ib-plans-note" role="status">
            Bringing in the plans you reviewed before…
          </p>
        )}
        {note}
      </div>
    </section>
  );
}
