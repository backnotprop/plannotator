import { useEffect, useRef, useState } from 'react';
import type { InboxPullRiskJudgment } from '@plannotator/core/inbox-types';
import { noHover } from '@plannotator/ui/utils/textCut';
import { Tip } from '../components/Tip';
import { riskLevelWord } from './risk';

/**
 * A pull request's risk: high stands out, medium is quiet, low is quietest. The
 * sentence shows on hover, and on a touch screen on a tap, which then doesn't
 * open the row the mark sits in. The sentence is plain text.
 */
export function RiskMark({ judgment }: { judgment: InboxPullRiskJudgment }) {
  const [tapped, setTapped] = useState(false);
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!tapped) return;
    const away = (event: PointerEvent) => {
      if (!mark.current?.contains(event.target as Node)) setTapped(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [tapped]);
  return (
    <Tip content={judgment.why} open={tapped ? true : undefined}>
      <span
        ref={mark}
        className="ib-risk"
        data-risk={judgment.level}
        data-pull-risk={judgment.level}
        onClick={(event) => {
          if (!noHover()) return;
          event.stopPropagation();
          event.preventDefault();
          setTapped((was) => !was);
        }}
      >
        {riskLevelWord[judgment.level]}
        <span className="ib-sr"> risk: {judgment.why}</span>
      </span>
    </Tip>
  );
}
