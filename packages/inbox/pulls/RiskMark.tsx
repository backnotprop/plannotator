import { useEffect, useRef, useState } from 'react';
import type { InboxPullRiskJudgment } from '@plannotator/core/inbox-types';
import { noHover } from '@plannotator/ui/utils/textCut';
import { Tip } from '../components/Tip';
import { riskLevelWord } from './risk';

export const COULD_NOT_RANK = 'Couldn\u2019t rank';

/**
 * A pull request's risk: high stands out, medium is quiet, low is quietest. One that
 * could not be ranked says so instead, with the reason, and has no level. The sentence
 * shows on hover, and on a touch screen on a tap, which then doesn't open the row the
 * mark sits in. The sentence is plain text.
 */
export function RiskMark({ judgment, failed }: { judgment?: InboxPullRiskJudgment | null; failed?: string | null }) {
  const [tapped, setTapped] = useState(false);
  const mark = useRef<HTMLSpanElement>(null);
  const level = judgment?.level ?? 'failed';
  const why = judgment?.why ?? failed ?? '';
  useEffect(() => {
    if (!tapped) return;
    const away = (event: PointerEvent) => {
      if (!mark.current?.contains(event.target as Node)) setTapped(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [tapped]);
  return (
    <Tip content={why} open={tapped ? true : undefined}>
      <span
        ref={mark}
        className="ib-risk"
        data-risk={level}
        data-pull-risk={level}
        onClick={(event) => {
          if (!noHover()) return;
          event.stopPropagation();
          event.preventDefault();
          setTapped((was) => !was);
        }}
      >
        {judgment ? riskLevelWord[judgment.level] : COULD_NOT_RANK}
        <span className="ib-sr">
          {judgment ? ' risk' : ''}: {why}
        </span>
      </span>
    </Tip>
  );
}
