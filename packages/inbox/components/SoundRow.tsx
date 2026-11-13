import { useEffect, useRef, useState } from 'react';
import { INBOX_SOUND_MAX_VOLUME, INBOX_SOUND_MIN_VOLUME } from '@plannotator/core/inbox-types';
import type { InboxSound } from '../sound';
import { Icon } from '../icons';

export function Switch({ on, labelledBy, label, disabled, onClick }: { on: boolean; labelledBy?: string; label?: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="switch" className="ib-sw" aria-checked={on} aria-labelledby={labelledBy} aria-label={label} disabled={disabled} onClick={onClick} />;
}

export function SoundRow({ sound }: { sound: InboxSound }) {
  const { enabled, volume } = sound.settings;
  const [live, setLive] = useState(volume);
  const slider = useRef<HTMLInputElement>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  useEffect(() => setLive(volume), [volume]);
  useEffect(() => {
    const el = slider.current;
    if (!el) return;
    const release = () => {
      const next = Number(el.value);
      soundRef.current.preview(next);
      void soundRef.current.setVolume(next);
    };
    el.addEventListener('change', release);
    return () => el.removeEventListener('change', release);
  }, []);
  return (
    <>
      <div className="ib-prow" data-settings-sound={enabled ? 'on' : 'off'}>
        <span className="ib-txt">
          <span className="ib-l" id="ib-sound-label">
            Play a sound
          </span>
          <span className="ib-desc">When an agent asks you, while no Inbox tab is in front</span>
        </span>
        <span className="ib-ctl">
          <input
            ref={slider}
            type="range"
            className="ib-vslider"
            min={INBOX_SOUND_MIN_VOLUME}
            max={INBOX_SOUND_MAX_VOLUME}
            step={10}
            value={live}
            aria-label="Volume"
            aria-valuetext={`${live} percent`}
            disabled={!enabled}
            onChange={(event) => setLive(Number(event.target.value))}
          />
          <button
            type="button"
            className="ib-btn ib-sm ib-icon"
            aria-label={sound.playing ? 'Playing…' : 'Play the sound'}
            data-sound-play=""
            onClick={() => sound.preview(live)}
          >
            <Icon name="play" />
          </button>
          <Switch on={enabled} labelledBy="ib-sound-label" onClick={() => void sound.setEnabled(!enabled)} />
        </span>
      </div>
      {enabled && !sound.armed && (
        <div className="ib-callout ib-in-card" role="status" data-sound-click-hint="">
          <Icon name="clickHere" />
          <span>Click once in this tab to allow sound.</span>
        </div>
      )}
    </>
  );
}
