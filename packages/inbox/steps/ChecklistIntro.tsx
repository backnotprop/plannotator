import { useEffect, useMemo, useState } from 'react';
import type { InboxStepStatus, InboxStepsWire } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { useReducedMotion } from '../tour/Tour';
import { stepsCount } from './model';
import { StepsPie } from './StepsMarks';
import { StepsLists } from './StepsList';

/**
 * The Checklist's one-time reveal (approval "inbox-checklist-reveal", 2026-11-04): the Board's first-visit
 * dialog's frame, type and buttons (`.ib-bi`), over a small thread foot whose checklist ticks itself from 1/4 to 4/4,
 * with its list open for a moment. Shown once, after the claim turned the Checklist on: "Open Settings" lands on
 * Settings → Capabilities, where its switch now reads on; "Got it" closes. Every way out is final. No keyboard
 * shortcut. Under reduced motion the picture rests on its last beat: 4/4, the list open.
 */
export function ChecklistIntro({ phone, onClose, onSettings }: { phone: boolean; onClose: () => void; onSettings: () => void }) {
  return (
    <Modal labelledBy="ib-ci-title" describedBy="ib-ci-desc" testId="checklist-intro" onClose={onClose} ownKeys className={`ib-bi ib-ci${phone ? ' ib-bi-phone' : ''}`}>
      <ChecklistIntroArt />
      <div className="ib-bi-text">
        <h2 id="ib-ci-title">Checklist</h2>
        <p id="ib-ci-desc">For longer work, agents keep a checklist at the foot of the thread and tick off steps as they go.</p>
        <p className="ib-bi-q">It starts with their next session. A tick never notifies you.</p>
      </div>
      <div className="ib-bi-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onSettings} data-checklist-intro-settings="">
          Open Settings
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={onClose} data-checklist-intro-close="">
          Got it
        </button>
      </div>
    </Modal>
  );
}

/** The picture's steps: an invoice fix, each short enough for one line at 320 px. */
const STEPS = ['Reproduce the bug', 'Find the extra line', 'Fix the PDF template', 'Run the invoice tests'];
/** When each step was ticked: minutes past 2 PM today. */
const DONE_AT = [8, 14, 21, 26];

/**
 * One loop, ms from its start: how many steps are done and whether the list is open. A beat holds until the next;
 * the last one fades the picture out, and the loop starts again.
 */
const BEATS: { at: number; done: number; open: boolean }[] = [
  { at: 0, done: 1, open: false },
  { at: 1400, done: 2, open: false },
  { at: 2800, done: 2, open: true },
  { at: 4300, done: 3, open: true },
  { at: 5800, done: 4, open: true },
  { at: 7600, done: 4, open: false },
];
const LOOP_MS = 10_000;
const FADE_MS = 400;

function useBeat(still: boolean): { done: number; open: boolean; fading: boolean } {
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
  if (still) return { done: STEPS.length, open: true, fading: false };
  return { done: BEATS[index]!.done, open: BEATS[index]!.open, fading };
}

/** The picture: the end of an agent's message and the thread's foot, Reply and the checklist button. Decoration only. */
function ChecklistIntroArt() {
  const still = useReducedMotion();
  const { done, open, fading } = useBeat(still);
  const list = useMemo<InboxStepsWire>(() => {
    const day = new Date();
    const at = (minute: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 14, minute).toISOString();
    const status = (i: number): InboxStepStatus => (i < done ? 'done' : i === done ? 'doing' : 'todo');
    return {
      id: 'stp_intro',
      project_id: 'prj_intro',
      thread_id: 'thr_intro',
      agent: { kind: 'agent', host: 'claude-code', session: 'ses_intro', name: null },
      steps: STEPS.map((step, i) => ({ step, status: status(i), note: null, at: at(DONE_AT[i]!) })),
      updated_at: at(DONE_AT[Math.max(0, done - 1)]!),
      presence: 'working',
    };
  }, [done]);
  const { done: d, total, text } = stepsCount(list);
  return (
    <div className="ib-bi-art ib-ci-art" aria-hidden="true" inert>
      <div className="ib-ci-stage" data-fading={fading ? '' : undefined} data-checklist-intro-count={text}>
        <div className="ib-ci-msg">
          <div className="ib-ci-who">
            <HostMark host="claude-code" />
            <span className="ib-bi-bars">
              <b style={{ width: '22%' }} />
            </span>
          </div>
          <span className="ib-bi-bars ib-ci-body">
            <b style={{ width: '92%' }} />
            <b style={{ width: '84%' }} />
            <b style={{ width: '58%' }} />
          </span>
        </div>
        <div className="ib-acts ib-footrow ib-ci-foot">
          <div className="ib-footbtns">
            <span className="ib-btn">
              <Icon name="reply" size={15} />
              Reply
            </span>
            <span className="ib-ci-anchor">
              <span className="ib-btn ib-st-btn ib-st-working" data-popup-open={open ? '' : undefined}>
                <StepsPie done={d} total={total} size={13} />
                <span className="ib-st-num">{text}</span>
                <span className="ib-oq-chev">
                  <Icon name="chevU" size={13} />
                </span>
              </span>
              {/* Over the message, from the button's left edge (a phone's: the stage's, as the popover shifts to fit). */}
              {open && (
                <div className="ib-stp ib-ci-pop">
                  <div className="ib-stp-scroll">
                    <StepsLists lists={[list]} />
                  </div>
                </div>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
