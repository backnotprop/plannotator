import { useEffect, useRef, useState } from 'react';
import { INBOX_SOUND_MAX_VOLUME, INBOX_SOUND_MIN_VOLUME, type InboxSoundWhen } from '@plannotator/core/inbox-types';
import type { InboxSound } from '../sound';
import { Icon } from '../icons';

export function Switch({ on, labelledBy, label, disabled, onClick }: { on: boolean; labelledBy?: string; label?: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="switch" className="ib-sw" aria-checked={on} aria-labelledby={labelledBy} aria-label={label} disabled={disabled} onClick={onClick} />;
}

/**
 * Play a sound: "questions and new threads" / "every agent message" (the owner's words and order,
 * 2026-11-18 and 2026-11-19; the second is the default), each with what it rings for under the choice.
 */
export const SOUND_WHEN_CHOICES: readonly { id: InboxSoundWhen; label: string; desc: string }[] = [
  { id: 'asks', label: 'questions and new threads', desc: 'While no Inbox tab is in front' },
  { id: 'messages', label: 'every agent message', desc: 'A reply, a new thread or a question, while no Inbox tab is in front' },
];

export function SoundRow({ sound }: { sound: InboxSound }) {
  const { enabled, volume, when } = sound.settings;
  const chosen = SOUND_WHEN_CHOICES.find((choice) => choice.id === when) ?? SOUND_WHEN_CHOICES[1]!;
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
          <span className="ib-seg ib-sound-when" role="radiogroup" aria-label="When to play a sound" aria-describedby="ib-sound-when-desc" data-sound-when={when}>
            {SOUND_WHEN_CHOICES.map((choice) => (
              <label key={choice.id} className="ib-seg-o" data-on={when === choice.id ? '' : undefined} data-sound-when-o={choice.id}>
                <input type="radio" name="ib-sound-when" value={choice.id} checked={when === choice.id} onChange={() => void sound.setWhen(choice.id)} />
                {choice.label}
              </label>
            ))}
          </span>
          <span className="ib-desc" id="ib-sound-when-desc">
            {chosen.desc}
          </span>
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
