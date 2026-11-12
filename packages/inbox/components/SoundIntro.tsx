import { useEffect, useRef } from 'react';
import { Icon } from '../icons';
import { Modal } from './Updates';

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
  onTurnOnNotifications: () => void;
  onKeep: () => void;
  onTurnOff: () => void;
}

export function SoundIntroDialog({ line, playing, onPlay, onTurnOnNotifications, onKeep, onTurnOff }: SoundIntroDialogProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const shownLine = useRef(line);
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
        <button type="button" className="ib-btn ib-sm" data-sound-play="" onClick={onPlay}>
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

function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('.ib-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}
