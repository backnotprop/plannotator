import { useEffect, useRef } from 'react';
import { Icon } from '../icons';
import { Modal } from './Updates';

/**
 * What the notification line says: nothing when notifications are on (or the
 * browser has none), else what needs fixing. Derived the way Settings reads
 * them: the browser's answer first, then the Inbox's switch.
 */
export type NotificationLine = 'on' | 'not-allowed' | 'off' | 'blocked';

export function notificationLine(enabled: boolean, permission: NotificationPermission | 'unsupported'): NotificationLine {
  if (permission === 'unsupported') return 'on';
  if (permission === 'denied') return 'blocked';
  if (!enabled) return 'off';
  return permission === 'granted' ? 'on' : 'not-allowed';
}

export interface SoundIntroDialogProps {
  line: NotificationLine;
  playing: boolean;
  onPlay: () => void;
  /** Allow (not allowed) or Turn on (off): the browser's own prompt when it has not decided. */
  onTurnOnNotifications: () => void;
  onKeep: () => void;
  onTurnOff: () => void;
}

/**
 * The one-time dialog after the update that brings the sound (design of
 * record: .product/approved/inbox-sound/, kept privately). A title with Play,
 * one sentence, a notification line only when something needs fixing, and
 * Turn it off · Keep it on. Keep it on has the first focus, Escape and the
 * backdrop keep it on, and Tab stays inside. No entrance motion.
 */
export function SoundIntroDialog({ line, playing, onPlay, onTurnOnNotifications, onKeep, onTurnOff }: SoundIntroDialogProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const shownLine = useRef(line);
  // The line changed under the person (Allow, Block, a change in another tab): focus follows it.
  useEffect(() => {
    if (shownLine.current === line) return;
    shownLine.current = line;
    const dialog = wrap.current?.closest('dialog');
    const target =
      (wrap.current?.querySelector('button') as HTMLElement | null) ??
      (wrap.current?.querySelector('[data-sound-nline]') as HTMLElement | null) ??
      (dialog?.querySelector('[data-sound-keep]') as HTMLElement | null);
    target?.focus();
  }, [line]);

  return (
    <Modal
      labelledBy="ib-sound-title"
      describedBy="ib-sound-desc"
      testId="sound-intro"
      onClose={onKeep}
      ownKeys
      fallbackFocus={pageHeading}
    >
      <div className="ib-dlg-head" data-notif={line}>
        <h2 id="ib-sound-title">The Inbox can ring now</h2>
        <button type="button" className="ib-btn ib-sm" aria-label="Play the sound" data-sound-play="" onClick={onPlay}>
          <Icon name="play" />
          <span>{playing ? 'Playing…' : 'Play'}</span>
        </button>
      </div>
      <p className="ib-sum" id="ib-sound-desc">
        A soft doorbell when an agent asks you something and this tab is hidden.
      </p>
      <div aria-live="polite" ref={wrap}>
        {line === 'not-allowed' && (
          <div className="ib-nline" data-sound-nline="not-allowed" tabIndex={-1}>
            Notifications aren&apos;t allowed yet.
            <button type="button" className="ib-lnk" onClick={onTurnOnNotifications}>
              Allow
            </button>
          </div>
        )}
        {line === 'off' && (
          <div className="ib-nline" data-sound-nline="off" tabIndex={-1}>
            Notifications are off.
            <button type="button" className="ib-lnk" onClick={onTurnOnNotifications}>
              Turn on
            </button>
          </div>
        )}
        {line === 'blocked' && (
          <div className="ib-nline" data-sound-nline="blocked" tabIndex={-1}>
            Notifications are blocked. Allow them from the address bar.
          </div>
        )}
      </div>
      <div className="ib-acts-row">
        <button type="button" className="ib-btn ib-ghost ib-left" data-sound-off="" onClick={onTurnOff}>
          Turn it off
        </button>
        <button type="button" className="ib-btn ib-pri" data-sound-keep="" onClick={onKeep}>
          Keep it on
        </button>
      </div>
    </Modal>
  );
}

/** Focus after the dialog when nothing focusable opened it: the page's heading. */
function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('.ib-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}
