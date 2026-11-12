import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@plannotator/ui/components/ui/dropdown-menu';
import type { InboxShapeSummary } from '../api';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { boardRows, type BoardRow } from '../review-drawing/showMeModel';

function BoardsMenu({ rows, current, onGo }: { rows: readonly BoardRow[]; current: string; onGo: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const anchor = () => (trigger.current?.closest('.shp-root.phone') ? trigger.current.closest<HTMLElement>('.shp-title-row') : null) ?? trigger.current;
  const at = rows.findIndex((row) => row.id === current);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => list.current?.querySelector('[data-on]')?.scrollIntoView?.({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={<button ref={trigger} type="button" className="ib-rj-btn" aria-label={`Boards: ${at + 1} of ${rows.length}`} data-shape-boards="" />}>
        <span className="ib-rj-lead">
          {at + 1} of {rows.length}
        </span>
        <Icon name="chevD" size={13} className="ib-rj-chev" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} anchor={anchor} className="ib-rj-menu" aria-label="Boards" data-review-jump-menu="boards" data-shape-boards-menu="">
        <div ref={list} className="ib-rj-list">
          {rows.map((row) => (
            <DropdownMenuItem
              key={row.id}
              className="ib-rj-row"
              style={{ '--ib-board-depth': row.depth } as React.CSSProperties}
              data-on={row.id === current ? '' : undefined}
              onClick={() => onGo(row.id)}
              data-shape-boards-row={row.id}
            >
              <span className="ib-rj-t">{row.title}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function useBoardsNav({
  shapes,
  threadId,
  board,
  parents,
  onBoard,
}: {
  shapes: readonly InboxShapeSummary[] | null;
  threadId: string | null;
  board: string | null;
  parents: ReadonlyMap<string, string>;
  onBoard: (id: string) => void;
}): { back: ReactNode; list: ReactNode } {
  const rows = useMemo(() => {
    const own = threadId ? (shapes ?? []).filter((shape) => shape.thread === threadId && (shape.state === 'active' || shape.id === board)) : [];
    return boardRows(own, parents);
  }, [shapes, threadId, board, parents]);
  const row = rows.find((one) => one.id === board);
  const up = row?.parent ? rows.find((one) => one.id === row.parent) : undefined;
  return {
    back: up ? (
      <Tip content={`Back to ${up.title}`}>
        <button type="button" className="ib-iconbtn ib-shape-back" aria-label={`Back to ${up.title}`} onClick={() => onBoard(up.id)} data-shape-board-back={up.id}>
          <Icon name="back" size={16} />
        </button>
      </Tip>
    ) : null,
    list: board && row && rows.length > 1 ? <BoardsMenu rows={rows} current={board} onGo={onBoard} /> : null,
  };
}
