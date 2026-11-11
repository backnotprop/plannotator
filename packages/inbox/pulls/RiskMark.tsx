import { useEffect, useRef, useState } from 'react';
import type { InboxPullRiskJudgment } from '@plannotator/core/inbox-types';
import { noHover } from '@plannotator/ui/utils/textCut';
import { Tip } from '../components/Tip';
import { riskLevelWord } from './risk';
import { placesWord, riskPlaceCount } from '../contextNotes/model';

export const COULD_NOT_RANK = 'Couldn\u2019t rank';

export function RiskMark({ judgment, failed }: { judgment?: InboxPullRiskJudgment | null; failed?: string | null }) {
  const [tapped, setTapped] = useState(false);
  const mark = useRef<HTMLSpanElement>(null);
  const level = judgment?.level ?? 'failed';
  const places = riskPlaceCount(judgment);
  const why = (judgment?.why ?? failed ?? '') + (places > 0 ? ` ${placesWord(places)} marked in the diff.` : '');
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
