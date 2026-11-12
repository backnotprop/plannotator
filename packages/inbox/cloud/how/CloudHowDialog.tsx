import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';
import { Modal } from '../../components/Updates';
import { HowElsewhere } from './HowElsewhere';
import { HowLimits } from './HowLimits';
import { HowPairing } from './HowPairing';
import { HowRelay } from './HowRelay';
import { HowReplies } from './HowReplies';

type Panel = {
  id: string;
  picture: ReactNode;
  seen: string;
  title: string;
  line: string;
};

const PANELS: Panel[] = [
  {
    id: 'elsewhere',
    picture: <HowElsewhere />,
    seen: 'Claude Code, Grok Bot, Muse, Hermes Agent and OpenClaw marks above an Inbox thread where Nightly fixer posts and you reply.',
    title: 'An agent that runs somewhere else',
    line: 'A Claude Code routine, Grok Bot, Muse, or a Hermes Agent or OpenClaw server. It posts to this Inbox and reads your replies.',
  },
  {
    id: 'pairing',
    picture: <HowPairing />,
    seen: 'Pick a kind and a name, copy the message Plannotator shows once, and the agent connects.',
    title: 'Pair it with one message',
    line: 'Pick its kind and a name, then send it the message Plannotator shows you. It sets itself up. A Claude Code routine gets three short pieces for its settings instead.',
  },
  {
    id: 'relay',
    picture: <HowRelay />,
    seen: 'Your computer and the cloud agent each call out to the relay in the middle. Messages in the relay are locked.',
    title: 'Messages pass through a locked mailbox',
    line: 'Your computer and the agent each call out to the relay, so your computer opens no door to the internet. Only they hold the keys: the relay cannot read a word.',
  },
  {
    id: 'limits',
    picture: <HowLimits />,
    seen: 'The agent sees the threads it started, was sent or was tagged in, not your other threads. It cannot answer your questions, approve anything, run anything on your computer or open your files.',
    title: 'It sees only its own threads',
    line: 'Threads it started, you sent it, or tagged it in. It reads and posts there, always under its own name.',
  },
  {
    id: 'replies',
    picture: <HowReplies />,
    seen: 'With a wake address, your reply starts the agent. Without one, it reads your reply when it next checks.',
    title: 'It hears back when you reply',
    line: 'With a wake address, your computer starts it when you write. Without one, it reads your reply when it next checks.',
  },
];

export function CloudHowDialog({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const [at, setAt] = useState(0);
  const [dir, setDir] = useState<'next' | 'back'>('next');
  const panel = PANELS[at]!;
  const last = at === PANELS.length - 1;
  const next = useRef<HTMLButtonElement>(null);
  const go = (to: number) => {
    setDir(to > at ? 'next' : 'back');
    setAt(to);
    if (to === 0) requestAnimationFrame(() => next.current?.focus());
  };
  return (
    <Modal labelledBy={`${uid}-t`} testId="cloud-how" onClose={onClose} ownKeys initialFocus=".ib-chow-next" className="ib-chow">
      <div className="ib-chow-head">
        <h2 id={`${uid}-t`}>How cloud agents work</h2>
        <button type="button" className="ib-btn ib-ghost ib-icon ib-chow-x" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-chow-body">
        <div key={panel.id} className="ib-chow-panel" data-dir={dir} data-cloud-how-panel={panel.id}>
          <div className="ib-chow-stage" role="img" aria-label={panel.seen}>
            {panel.picture}
          </div>
          <div className="ib-chow-words" aria-live="polite">
            <h3 className="ib-chow-t">{panel.title}</h3>
            <p className="ib-chow-l">{panel.line}</p>
            {last && (
              <p className="ib-chow-end" data-cloud-how-end="">
                Remove cuts it off at once. A new pairing stops the old one.
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="ib-chow-foot">
        <span className="ib-chow-dots">
          {PANELS.map((p, i) => (
            <i key={p.id} data-on={i === at ? '' : undefined} />
          ))}
          <span className="ib-chow-sr" data-cloud-how-step={at + 1}>
            {at + 1} of {PANELS.length}
          </span>
        </span>
        {at > 0 && (
          <button type="button" className="ib-btn ib-ghost ib-chow-back" onClick={() => go(at - 1)} data-cloud-how-back="">
            Back
          </button>
        )}
        <button ref={next} type="button" className="ib-btn ib-pri ib-chow-next" onClick={() => (last ? onClose() : go(at + 1))} data-cloud-how-next="">
          {last ? 'Done' : 'Next'}
        </button>
      </div>
    </Modal>
  );
}
