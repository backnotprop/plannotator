/**
 * The `#` list on a plain field (New card's title and notes; approval
 * "board-hashtags"): the skill list's own menu, hung off the field's line
 * (a textarea: the caret's line; an input: the field). Its wrapper is the
 * field's `position: relative` box (`.ib-hashwrap`).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { caretLineRect } from '../caretMenu';
import { hashtagMenuLeft, type HashtagMenu } from '../hashtags';

export function HashtagFieldMenu({
  id,
  field,
  menu,
  onSelect,
  prefer = 'below',
}: {
  id: string;
  field: HTMLInputElement | HTMLTextAreaElement | null;
  menu: HashtagMenu;
  onSelect: (index: number) => void;
  prefer?: 'above' | 'below';
}) {
  const [line, setLine] = useState<{ top: number; height: number } | null>(null);
  const [x, setX] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (field && anchor) {
      const next = hashtagMenuLeft(field, menu.start, anchor.left, anchor.width);
      setX((prev) => (prev === next ? prev : next));
    }
    if (!(field instanceof HTMLTextAreaElement)) return setLine(null);
    const rect = caretLineRect(field);
    const box = field.parentElement?.getBoundingClientRect();
    if (!rect || !box) return setLine(null);
    const next = { top: Math.round(rect.top - box.top), height: Math.round(rect.bottom - rect.top) };
    setLine((prev) => (prev && prev.top === next.top && prev.height === next.height ? prev : next));
  });
  return (
    <div
      ref={anchorRef}
      className="ib-hashanchor"
      data-hashtag-menu=""
      onMouseDown={(event) => event.preventDefault()}
      style={{ ...(line ? { top: line.top, height: line.height } : { top: 0, bottom: 0 }), '--ib-hash-x': `${x}px` } as unknown as React.CSSProperties}
    >
      <SkillReferenceMenu id={id} items={menu.items} activeIndex={menu.activeIndex} onSelect={onSelect} prefer={prefer} maxListHeight={220} />
    </div>
  );
}
