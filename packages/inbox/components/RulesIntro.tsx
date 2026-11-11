import { useEffect, useState } from 'react';
import { HostMark, Icon } from '../icons';
import { useReducedMotion } from '../tour/Tour';
import { Modal } from './Updates';

/**
 * "Set the rules", the one-time dialog for Rules for your agents (#2194; the owner approved it, 2026-11-11: "Yes, the
 * Settings place and this dialog"). The Board's and the Checklist's frame, type and buttons (`.ib-bi`) over a small
 * picture: an agent's long message, then the person's rules arrive and shape it (shorter, a stray update gone, the
 * question up front). "Add your rules" opens Settings → Prompts with the editor open; "Not now", Escape and a click
 * outside close it. Every way out is final: the claim already stamped it. No keyboard shortcut. Under reduced motion
 * the picture rests on its last beat; it runs only while the dialog is open.
 */
export function RulesIntro({ phone, onClose, onAdd }: { phone: boolean; onClose: () => void; onAdd: () => void }) {
  return (
    <Modal labelledBy="ib-ri-title" describedBy="ib-ri-desc" testId="rules-intro" onClose={onClose} ownKeys className={`ib-bi ib-ri${phone ? ' ib-bi-phone' : ''}`}>
      <RulesIntroArt />
      <div className="ib-bi-text">
        <h2 id="ib-ri-title">Set the rules</h2>
        <p id="ib-ri-desc">Add custom instructions for how you want your agents to use your Inbox.</p>
        <p className="ib-bi-q">They go along with Plannotator's own. Change them any time in Settings.</p>
      </div>
      <div className="ib-bi-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-rules-intro-close="">
          Not now
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={onAdd} data-rules-intro-add="">
          Add your rules
        </button>
      </div>
    </Modal>
  );
}

const RULES = ['Keep messages short', 'Only when blocked or done'];
/** One loop, ms from its start: rules shown, the message shortened, the stray update gone, the question up front. */
const BEATS = [
  { at: 0, rules: 0, short: false, gone: false, ask: false },
  { at: 1300, rules: 1, short: false, gone: false, ask: false },
  { at: 2300, rules: 1, short: true, gone: false, ask: false },
  { at: 3700, rules: 2, short: true, gone: false, ask: false },
  { at: 4600, rules: 2, short: true, gone: true, ask: true },
];
const LAST = BEATS[BEATS.length - 1]!;
const LOOP_MS = 9000;
const FADE_MS = 400;
const LINE_WIDTHS = [92, 86, 95, 78, 88, 64];

function useBeat(still: boolean): (typeof BEATS)[number] & { fading: boolean } {
  const [index, setIndex] = useState(0);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (still) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const loop = () => {
      setFading(false);
      BEATS.forEach((beat, i) => timers.push(setTimeout(() => setIndex(i), beat.at)));
      timers.push(setTimeout(() => setFading(true), LOOP_MS - FADE_MS));
      timers.push(setTimeout(loop, LOOP_MS));
    };
    loop();
    return () => timers.forEach(clearTimeout);
  }, [still]);
  return still ? { ...LAST, fading: false } : { ...BEATS[index]!, fading };
}

/** The picture. Decoration only (aria-hidden). */
function RulesIntroArt() {
  const beat = useBeat(useReducedMotion());
  const on = (value: boolean) => (value ? '' : undefined);
  return (
    <div className="ib-bi-art" aria-hidden="true">
      <div className="ib-ri-stage" data-fading={on(beat.fading)}>
        <div className="ib-ri-rules">
          {RULES.map((rule, i) => (
            <span className="ib-ri-rule" key={rule} data-on={on(beat.rules > i)}>
              <Icon name="check" size={12} />
              {rule}
            </span>
          ))}
        </div>
        <div className="ib-ri-msgs">
          <div className="ib-ri-card ib-ri-update" data-gone={on(beat.gone)}>
            <div className="ib-ri-head">
              <HostMark host="codex" />
              <span className="ib-ri-t" style={{ width: '30%' }} />
              <span className="ib-ri-when" />
            </div>
          </div>
          <div className="ib-ri-card ib-ri-main" data-short={on(beat.short)}>
            <div className="ib-ri-head">
              <HostMark host="claude-code" />
              <span className="ib-ri-t" />
              <span className="ib-ri-when" />
            </div>
            <div className="ib-ri-lines">
              {LINE_WIDTHS.map((width, i) => (
                <b key={i} style={{ width: `${width}%` }} data-cut={on(beat.short && i >= 2)} />
              ))}
            </div>
            <div className="ib-ri-ask" data-on={on(beat.ask)}>
              <i />
              <b />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
