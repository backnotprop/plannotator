import type { MouseEvent, Ref } from 'react';
import { HostMark } from '../icons';

interface Common {
  open: boolean;
  onClick: () => void;
  ariaLabel: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /** A press leaves focus where it is (the reply's words), as iOS does by itself, so the sheet knows what to give focus back to. */
  keepFocus?: boolean;
  attrs?: Record<string, string | boolean | undefined>;
}

const stay = (event: MouseEvent) => event.preventDefault();

const Chevron = () => (
  <svg className="ib-apill-c" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m19.5 8.25-7.5 7.5-7.5-7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function AgentPill({
  host,
  agent,
  label,
  detail,
  ask = false,
  struck = false,
  disabled,
  open,
  onClick,
  ariaLabel,
  buttonRef,
  keepFocus,
  attrs,
}: Common & {
  host?: string | null;
  agent?: string | null;
  label: string | null;
  detail?: string | null;
  ask?: boolean;
  struck?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" ref={buttonRef} className="ib-apill" data-agent-pill="" data-ask={ask ? '' : undefined} data-open={open ? '' : undefined} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} onMouseDown={keepFocus ? stay : undefined} onClick={onClick} {...attrs}>
      {host !== undefined && (
        <span className="ib-apill-m">
          <HostMark host={host} agent={agent} />
        </span>
      )}
      {label !== null && (
        <span className="ib-apill-n" dir="auto">
          {struck ? <s>{label}</s> : label}
        </span>
      )}
      {detail && <span className="ib-apill-d">{detail}</span>}
      <Chevron />
    </button>
  );
}

export function AgentMark({
  host,
  agent,
  count,
  open,
  onClick,
  ariaLabel,
  buttonRef,
  keepFocus,
  attrs,
}: Common & {
  host: string | null;
  agent?: string | null;
  count: number;
}) {
  return (
    <button type="button" ref={buttonRef} className="ib-pchip ib-amark" data-agent-mark="" data-open={open ? '' : undefined} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} onMouseDown={keepFocus ? stay : undefined} onClick={onClick} {...attrs}>
      <span className="ib-amark-m">
        <HostMark host={host} agent={agent} />
      </span>
      <span className="ib-amark-n" data-agent-count="" aria-hidden="true">
        {count}
      </span>
    </button>
  );
}
