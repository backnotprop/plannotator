/**
 * The Launch tip's card (approval "launch-tip", variant Beside; rules in launchTip.ts): the tour's coach card look
 * (`.ib-tour-coach`), drawn inside compose's To row, so inside the modal `<dialog>` (a portal to the body would sit
 * under the backdrop, inert) and one Tab after To. It never takes focus: Got it keeps focus where it was on a press,
 * and on a keyboard press sends it to To, the thing the tip was about.
 */
import { useRef } from 'react';
import { LAUNCH_TIP_WORDS, type LaunchTipPlace } from './launchTip';

export function LaunchTipCard(props: {
  place: LaunchTipPlace | null;
  phone: boolean;
  leaving: boolean;
  titleId: string;
  lineId: string;
  /** Got it. `keyboard`: the button had focus (it was pressed from the keyboard). */
  onOk: (keyboard: boolean) => void;
}) {
  const { place, leaving } = props;
  const okRef = useRef<HTMLButtonElement>(null);
  const side = place?.side ?? 'right';
  return (
    <div
      className="ib-tour-coach ib-ctip"
      role="group"
      aria-labelledby={props.titleId}
      aria-hidden={leaving || undefined}
      data-launch-tip=""
      data-side={side}
      data-phone={props.phone ? '' : undefined}
      data-leaving={leaving ? '' : undefined}
      style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
    >
      <span className="ib-ctip-arrow" data-side={side === 'right' ? 'left' : 'up'} style={side === 'below' && place ? { left: place.arrow } : undefined} aria-hidden="true" />
      <div className="ib-tc-eb">{LAUNCH_TIP_WORDS.eyebrow}</div>
      <h2 id={props.titleId}>{LAUNCH_TIP_WORDS.title}</h2>
      <p id={props.lineId}>{LAUNCH_TIP_WORDS.line}</p>
      <div className="ib-tc-acts">
        <span className="ib-sp" />
        <button
          ref={okRef}
          type="button"
          className="ib-tc-next"
          data-launch-tip-ok=""
          tabIndex={leaving ? -1 : undefined}
          // A pointer press never takes focus from the message or To.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onOk(document.activeElement === okRef.current)}
        >
          {LAUNCH_TIP_WORDS.ok}
        </button>
      </div>
    </div>
  );
}
