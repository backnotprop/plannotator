/**
 * The agent control in a phone's composer row (approval "inbox-phone-composer-picker"): who gets the words, as a
 * button that opens the picker sheet.
 *
 * - `AgentPill`: the agent's mark, a short name that gives way with "…", and a small chevron. New message's To, and
 *   the reply row of a thread with several agents (the person sees who gets the reply).
 * - `AgentMark`: the mark alone, round like the paperclip and Skills beside it. The reply row of a thread with one
 *   agent, where it is seldom changed; with several recipients, the first mark and how many.
 *
 * Both are 36 px tall with a 44 px touch area (phoneComposer.css).
 */
import type { MouseEvent, Ref } from 'react';
import { HostMark, Icon } from '../icons';

interface Common {
  open: boolean;
  onClick: () => void;
  ariaLabel: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /**
   * A press leaves focus where it is (the reply's words), as iOS does by itself: the sheet then knows what to give
   * focus back to on every browser. From the keyboard the button has focus, and gets it back.
   */
  keepFocus?: boolean;
  /** `data-*` and `aria-*` attributes for the page's own lookups and descriptions. */
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
  /** The agent whose mark leads the words. Undefined: no mark ("Choose an agent"). */
  host?: string | null;
  label: string;
  /** A quiet word after the name ("ended"). */
  detail?: string | null;
  /** Nobody is chosen yet: the pill asks, in the primary colour. */
  ask?: boolean;
  /** The session ended: its name is struck through. */
  struck?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" ref={buttonRef} className="ib-apill" data-agent-pill="" data-ask={ask ? '' : undefined} data-open={open ? '' : undefined} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} onMouseDown={keepFocus ? stay : undefined} onClick={onClick} {...attrs}>
      {host !== undefined && (
        <span className="ib-apill-m">
          <HostMark host={host} />
        </span>
      )}
      <span className="ib-apill-n" dir="auto">
        {struck ? <s>{label}</s> : label}
      </span>
      {detail && <span className="ib-apill-d">{detail}</span>}
      <Chevron />
    </button>
  );
}

export function AgentMark({
  host,
  count = 1,
  ended = false,
  open,
  onClick,
  ariaLabel,
  buttonRef,
  keepFocus,
  attrs,
}: Common & {
  /** The first recipient's agent. Undefined: nobody is chosen. */
  host?: string | null;
  /** How many get the words: past one, a count at the button's corner. */
  count?: number;
  ended?: boolean;
}) {
  return (
    <button type="button" ref={buttonRef} className="ib-pchip ib-amark" data-agent-mark="" data-ended={ended ? '' : undefined} data-open={open ? '' : undefined} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} onMouseDown={keepFocus ? stay : undefined} onClick={onClick} {...attrs}>
      {host === undefined ? (
        <Icon name="user" size={20} />
      ) : (
        <span className="ib-amark-m">
          <HostMark host={host} />
        </span>
      )}
      {count > 1 && (
        <span className="ib-amark-n" data-agent-count="" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );
}
