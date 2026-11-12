import { useEffect, useMemo, useState } from 'react';
import type { InboxStepStatus, InboxStepsWire } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { useReducedMotion } from '../tour/Tour';
import { stepsCount } from './model';
import { StepsButtonFace } from './StepsButton';
import { StepsLists } from './StepsList';

export function ChecklistIntro({ phone, onClose, onTurnOn }: { phone: boolean; onClose: () => void; onTurnOn: () => void }) {
  return (
    <Modal labelledBy="ib-ci-title" describedBy="ib-ci-desc" testId="checklist-intro" onClose={onClose} ownKeys className={`ib-bi ib-ci${phone ? ' ib-bi-phone' : ''}`}>
      <ChecklistIntroArt />
      <div className="ib-bi-text">
        <h2 id="ib-ci-title">Checklist</h2>
        <p id="ib-ci-desc">For longer work, agents keep a checklist at the foot of the thread and tick off steps as they go.</p>
        <p className="ib-bi-q">It starts with their next session after you turn it on. A tick never notifies you.</p>
      </div>
      <div className="ib-bi-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-checklist-intro-close="">
          Not now
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={onTurnOn} data-checklist-intro-on="">
          Turn it on
        </button>
      </div>
    </Modal>
  );
}

const STEPS = ['Reproduce the bug', 'Find the extra line', 'Fix the PDF template', 'Run the invoice tests'];
const DONE_AT = [8, 14, 21, 26];

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
  const { text } = stepsCount(list);
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
                <StepsButtonFace list={list} />
              </span>
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
