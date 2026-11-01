/**
 * The one-time voice announcement, shaped like the list options intro (ListLookIntro.tsx): a picture in the
 * always-light frame, a title, a line, then the choice. Turn on voice only sets the switch: the browser's microphone
 * prompt comes at the first press of the mic. Not now and Escape change nothing, and the Inbox has already retired it.
 */
import { useId, useState } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { Icon } from '../icons';
import { lightScope } from './ListLookIntro';
import { Modal } from './Updates';

const BARS = [0.3, 0.55, 0.8, 0.45, 0.62, 0.9, 0.5, 0.12, 0.1, 0.34, 0.7, 0.95, 0.6, 0.76, 0.4, 0.84, 0.58, 0.3, 0.42, 0.66, 0.88, 0.52];

/** The picture: a reply box mid-sentence. Not interactive. */
function Picture() {
  return (
    <div className="ib-vo-picture" aria-hidden="true">
      <div className="ib-rbox">
        <div className="ib-vo-text">
          Cards. But keep the totals column from the table design, and
          <span className="ib-vcaret" style={{ transform: 'scaleY(0.82)' }} />
        </div>
        <div className="ib-rfoot">
          <span className="ib-rclip">
            <Icon name="clip" size={16} />
          </span>
          <div className="ib-dtfoot">
            <span className="ib-vline">
              <b>Listening</b>
              <span className="ib-vsp" />
              <span className="ib-vbars">
                {BARS.map((level, index) => (
                  <span key={index} style={{ transform: `scaleY(${level})` }} data-v={level > 0.2 ? '' : undefined} />
                ))}
              </span>
              <span className="ib-dttime">0:07</span>
            </span>
            <span className="ib-vmic" data-state="live">
              <Icon name="mic" size={16} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function VoiceIntro({ phone, onTurnOn, onKeep }: { phone: boolean; onTurnOn: (phonesOnly: boolean) => void; onKeep: () => void }) {
  const { lightTheme } = useTheme();
  const [phonesOnly, setPhonesOnly] = useState(false);
  const base = `ib-vo-${useId().replace(/:/g, '')}`;
  return (
    <Modal labelledBy="ib-vo-title" describedBy="ib-vo-desc" testId="voice-intro" onClose={onKeep} ownKeys className={`ib-lo ib-vo${phone ? ' ib-lo-phone' : ''}`}>
      <div className="ib-lo-art">
        <div className={`ib-lo-frame ib-vo-frame ${lightScope(lightTheme)}`} inert>
          <Picture />
        </div>
      </div>
      <div className="ib-lo-text">
        <h2 id="ib-vo-title">Talk instead of typing</h2>
        <p id="ib-vo-desc">Hold the microphone in a reply box, or tap it, and speak. Your words land in the box, and nothing goes out until you press Send.</p>
        <p className="ib-vo-route">Your audio goes to OpenAI through your ChatGPT login in Codex. This route isn’t an official OpenAI API, so it can stop working without notice.</p>
      </div>
      <div className="ib-lo-sw">
        <label className="ib-lo-opt" htmlFor={base}>
          <span id={`${base}-l`}>Phones only</span>
          <button type="button" role="switch" id={base} className="ib-sw" aria-checked={phonesOnly} aria-labelledby={`${base}-l`} onClick={() => setPhonesOnly(!phonesOnly)} data-voice-intro-phones="" />
        </label>
      </div>
      <div className="ib-lo-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onKeep} data-voice-intro-keep="">
          Not now
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri" onClick={() => onTurnOn(phonesOnly)} data-voice-intro-on="">
          Turn on voice
        </button>
      </div>
    </Modal>
  );
}
