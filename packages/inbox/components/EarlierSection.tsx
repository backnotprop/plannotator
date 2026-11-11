import { useEffect, useRef, useState } from 'react';
import type { EarlierReply } from '../earlierComments';
import { Icon } from '../icons';
import { EarlierCommentsList } from './EarlierCommentsList';

export function commentsLabel(count: number, earlier: number): string {
  if (earlier === 0) return `Comments, ${count}`;
  return count === 0 ? `Comments, ${earlier} earlier` : `Comments, ${count}, ${earlier} earlier`;
}

export function CommentCount({ count, earlier, phone = false, bump = 0 }: { count: number; earlier: number; phone?: boolean; bump?: number }) {
  if (earlier > 0 && count === 0) return <span className="ib-earlier-cnt">{earlier}</span>;
  return (
    <>
      <span key={bump} className={bump ? 'ib-bump' : undefined}>
        {count}
      </span>
      {earlier > 0 && !phone && <span className="ib-earlier-cnt">· {earlier}</span>}
    </>
  );
}

export function EarlierSection({ replies, count, current, inAllFiles, shown }: { replies: readonly EarlierReply[]; count: number; current: number; inAllFiles: boolean; shown: boolean }) {
  const [open, setOpen] = useState(current === 0);
  const sectionRef = useRef<HTMLElement>(null);
  const opened = useRef(false);
  const hadCurrent = useRef(current > 0);
  useEffect(() => {
    if (current === 0 && hadCurrent.current) setOpen(true);
    hadCurrent.current = current > 0;
  }, [current]);
  // Opened at the foot of a short column (a phone's sheet), the list starts out of sight: bring in its first comment.
  useEffect(() => {
    if (!open || !opened.current) return;
    opened.current = false;
    sectionRef.current?.querySelector('[data-earlier-comment]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const toggle = () => {
    opened.current = !open;
    setOpen(!open);
  };
  return (
    <section ref={sectionRef} className="ib-earlier" data-after={current > 0 || inAllFiles ? '' : undefined} data-earlier-section="">
      <button type="button" className="ib-earlier-row" aria-expanded={open} onClick={toggle} data-earlier-row="">
        <Icon name="chevD" />
        <span>{inAllFiles ? 'Earlier on this file' : 'Earlier'}</span>
        <span className="ib-earlier-n">{count}</span>
      </button>
      {open && shown && <EarlierCommentsList replies={replies} />}
    </section>
  );
}
