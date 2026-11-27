import { Switch } from '../components/SoundRow';
import { CONTENTS_DOTS_DESC, CONTENTS_DOTS_LABEL, setContentsDotsShown, useContentsDotsShown } from '../data/contentsDots';

/** Settings → General → Appearance: whether the contents rail draws comment dots (data/contentsDots.ts). */
export function ContentsDotsRow() {
  const on = useContentsDotsShown();
  return (
    <div className="ib-prow" data-settings-contents-dots={on ? 'on' : 'off'}>
      <span className="ib-txt">
        <span className="ib-l" id="ib-contents-dots-label">
          {CONTENTS_DOTS_LABEL}
        </span>
        <span className="ib-desc">{CONTENTS_DOTS_DESC}</span>
      </span>
      <span className="ib-ctl">
        <Switch on={on} labelledBy="ib-contents-dots-label" onClick={() => setContentsDotsShown(!on)} />
      </span>
    </div>
  );
}
