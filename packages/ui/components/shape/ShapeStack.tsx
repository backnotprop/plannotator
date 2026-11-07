/**
 * Stack badges on a Shape board (approval "stack-show-me", addendum 2026-11-06: take C and the card of round 2, take
 * 1). Only with `ShapeSurface`'s `stackBadges`, and only on a board whose data names two or more PRs (`stack`).
 *
 *  - The row under the title: "Stack of 3", then each PR with its icon and colour. A click keeps that PR's parts
 *    bright and fades the rest; a second click restores them.
 *  - A tag per PR on each part it changed (`StackBadgeLayer`, on the Picture and How it works drawings).
 *  - A tag opens its card by it: "#2547 What it shows" (the PR's link), "In <part>", the agent's words, a row per
 *    file with its counts, "Also changed here by #2546" (switches the card) and "Read it in the review ›" (the
 *    review's chapter for that PR, narrowed to the part's files: `review.open({ step, narrow })`). On a phone the card
 *    is a sheet at the bottom.
 *  - A file opens its lines in the code popup: "‹ <part>" (back to the card), "from #2547 What it shows", and
 *    "1 of 3 files ‹ ›".
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { shapeStackBadges, shapeStackColour, type ShapeStack, type ShapeVersion } from '@plannotator/core/shape';
import { PopoutDialog } from '../PopoutDialog';
import { CodeFilePopout } from '../CodeFilePopout';
import { ShapePatch } from './ShapeCode';
import { StackBadgeLayer, PR_ICON_SVG } from './stackBadges';
import { stackCard, stackFileCounts, stackFileName, stackFilePatch, stackPartName } from './stackModel';
import type { ShapeSurfaceReview } from './types';

const PrIcon = () => <span className="shp-stk-ic" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PR_ICON_SVG }} />;
const FileIcon = () => (
  <svg className="shp-stk-fic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);
const Chevron = ({ back = false }: { back?: boolean }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={back ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
  </svg>
);

/** A PR as a coloured chip: its icon and number, and its title beside it when asked. A link when it has one. */
function PrName({ stack, n, title = true, link = true }: { stack: ShapeStack; n: number; title?: boolean; link?: boolean }) {
  const pull = stack.pulls.find((p) => p.n === n);
  const chip = (
    <span className="shp-stk-pr" data-c={shapeStackColour(stack, n)}>
      <PrIcon />#{n}
    </span>
  );
  const body = (
    <>
      {chip}
      {title && pull && <span className="shp-stk-prt">{pull.title}</span>}
    </>
  );
  return link && pull?.url ? (
    <a className="shp-stk-prlink" href={pull.url} target="_blank" rel="noreferrer noopener">
      {body}
    </a>
  ) : (
    <span className="shp-stk-prlink">{body}</span>
  );
}

type Open = { pr: number; part: string; name: string; tag: HTMLElement };

export interface ShapeStackState {
  /** Whether the board shows stack badges at all (a stack of two or more PRs, and the host asked). */
  on: boolean;
  /** For a drawn view's `onBoard`: puts the tags on that drawing (null: it is gone). */
  boardFor: (view: 'picture' | 'how') => (board: HTMLElement | null) => void;
  /** The row of PRs under the title. */
  row: React.ReactNode;
  /** The card, the file popup. */
  overlay: React.ReactNode;
  /** A card or popup is open: Esc is theirs. */
  open: boolean;
}

export function useShapeStack({
  enabled,
  version,
  phone,
  root,
  review,
  readFile,
}: {
  enabled: boolean;
  version: ShapeVersion | null;
  phone: boolean;
  root: HTMLElement | null;
  review: ShapeSurfaceReview | null;
  readFile?: (path: string) => Promise<string | null>;
}): ShapeStackState {
  const stack = enabled ? version?.stack : undefined;
  const badges = useMemo(() => shapeStackBadges(stack), [stack]);
  const on = !!stack && stack.pulls.length >= 2;
  const [pick, setPick] = useState<number | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [file, setFile] = useState<number | null>(null);
  const layers = useRef(new Map<'picture' | 'how', StackBadgeLayer>());
  const openRef = useRef(setOpen);
  openRef.current = setOpen;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const openNow = useRef(open);
  openNow.current = open;

  // The drawings' layers: one per drawing shown, built afresh when the drawing is, or when a new version's stack is.
  const boards = useRef(new Map<'picture' | 'how', HTMLElement>());
  const boardFns = useMemo(() => {
    const make = (view: 'picture' | 'how') => (board: HTMLElement | null) => {
      layers.current.get(view)?.destroy();
      layers.current.delete(view);
      if (board) boards.current.set(view, board);
      else boards.current.delete(view);
      if (!board || !on || !stack) return;
      const layer = new StackBadgeLayer(board, {
        badges,
        colour: (n) => shapeStackColour(stack, n),
        onOpen: (pr, part, tag) => {
          const mark = board.querySelector(`[data-mark="${part.replace(/["\\]/g, '\\$&')}"]`);
          setFile(null);
          openRef.current((was) => (was && was.pr === pr && was.part === part ? null : { pr, part, name: mark ? stackPartName(mark) : part, tag }));
        },
      });
      layer.setPick(pickRef.current);
      const now = openNow.current;
      if (now) layer.setOpen({ pr: now.pr, part: now.part });
      layers.current.set(view, layer);
    };
    return { picture: make('picture'), how: make('how') };
  }, [badges, on, stack]);
  useEffect(() => {
    for (const [view, board] of [...boards.current]) if (board.isConnected) boardFns[view](board);
  }, [boardFns]);
  useEffect(() => () => {
    for (const layer of layers.current.values()) layer.destroy();
    layers.current.clear();
  }, []);
  useEffect(() => {
    for (const layer of layers.current.values()) layer.setPick(pick);
  }, [pick]);
  useEffect(() => {
    for (const layer of layers.current.values()) layer.setOpen(open ? { pr: open.pr, part: open.part } : null);
  }, [open]);
  // A new version without that PR or part closes what was open on it.
  useEffect(() => {
    if (!on) {
      setPick(null);
      setOpen(null);
      setFile(null);
      return;
    }
    if (pick !== null && !stack!.pulls.some((p) => p.n === pick)) setPick(null);
    if (open && !stackCard(stack!, open.part, open.pr)) {
      setOpen(null);
      setFile(null);
    }
  }, [on, stack, pick, open]);

  // Closed in place, focus goes back to its tag; closed by leaving for the review, the review takes it.
  const close = useCallback((focus: boolean = true) => {
    const tag = openNow.current?.tag;
    setOpen(null);
    setFile(null);
    if (focus && tag?.isConnected) tag.focus({ preventScroll: true });
  }, []);

  const row = on ? (
    <div className="shp-stk-row" role="group" aria-label="Pull requests in this stack" data-shp-stack-row="">
      <span className="shp-stk-row-l">Stack of {stack!.pulls.length}</span>
      {stack!.pulls.map((p) => (
        <button
          key={p.n}
          type="button"
          className={`shp-stk-chip${pick === p.n ? ' on' : ''}`}
          data-c={shapeStackColour(stack!, p.n)}
          aria-pressed={pick === p.n}
          aria-label={`#${p.n} ${p.title}: show only its parts`}
          data-shp-stack-pick={p.n}
          onClick={() => setPick(pick === p.n ? null : p.n)}
        >
          <PrIcon />
          <b>#{p.n}</b>
          {!phone && <span className="shp-stk-chip-t">{p.title}</span>}
        </button>
      ))}
    </div>
  ) : null;

  let overlay: React.ReactNode = null;
  if (on && open) {
    const card = stackCard(stack!, open.part, open.pr);
    if (card) {
      overlay =
        file === null ? (
          <StackCard
            stack={stack!}
            card={card}
            partName={open.name}
            anchor={open.tag}
            root={root}
            phone={phone}
            review={review}
            onClose={close}
            onFile={setFile}
            onSwitch={(n) => {
              setFile(null);
              setOpen({ ...open, pr: n });
            }}
          />
        ) : (
          <StackFile
            stack={stack!}
            card={card}
            partName={open.name}
            index={file}
            phone={phone}
            review={review}
            readFile={readFile}
            onBack={() => setFile(null)}
            onClose={() => close()}
            onGo={setFile}
          />
        );
    }
  }

  return { on, boardFor: (view) => boardFns[view], row, overlay, open: on && !!open };
}

type Card = NonNullable<ReturnType<typeof stackCard>>;

/** One file row's counts, from the agent or the review's patch. */
function useFileRows(card: Card, review: ShapeSurfaceReview | null) {
  const [patch, setPatch] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (!review?.patch) {
      setPatch(null);
      return;
    }
    Promise.resolve()
      .then(() => review.patch!())
      .then((p) => live && setPatch(p ?? null), () => live && setPatch(null));
    return () => {
      live = false;
    };
  }, [review]);
  const rows = useMemo(
    () =>
      card.change.files.map((f) => {
        const filePatch = patch ? stackFilePatch(patch, f.path, f.lines) : null;
        return { file: f, patch: filePatch, counts: stackFileCounts(f, filePatch) };
      }),
    [card, patch],
  );
  return { rows, ready: patch !== undefined };
}

function Counts({ counts }: { counts: { additions: number; deletions: number } | null }) {
  if (!counts) return null;
  return (
    <span className="shp-stk-counts">
      {counts.additions > 0 && <span className="add">+{counts.additions}</span>}
      {counts.deletions > 0 && <span className="del">−{counts.deletions}</span>}
    </span>
  );
}

function StackCard({
  stack,
  card,
  partName,
  anchor,
  root,
  phone,
  review,
  onClose,
  onFile,
  onSwitch,
}: {
  stack: ShapeStack;
  card: Card;
  partName: string;
  anchor: HTMLElement;
  root: HTMLElement | null;
  phone: boolean;
  review: ShapeSurfaceReview | null;
  onClose: (focus?: boolean) => void;
  onFile: (i: number) => void;
  onSwitch: (n: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { rows } = useFileRows(card, review);
  const { pull, change, others } = card;

  // By its tag: under it, never over the part it speaks of; above only when there is no room below. Follows the tag
  // when the board scrolls or resizes.
  useLayoutEffect(() => {
    if (phone || !root) return;
    const place = () => {
      const el = ref.current;
      if (!el || !anchor.isConnected) return;
      const a = anchor.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.min(Math.max(12, a.left - r.left - 6), r.width - w - 12);
      const below = a.bottom - r.top + 8;
      const top = below + h < r.height - 12 ? below : Math.max(12, a.top - r.top - 8 - h);
      setPos((was) => (was && was.left === left && was.top === top ? was : { left, top }));
    };
    place();
    const again = () => requestAnimationFrame(place);
    root.addEventListener('scroll', again, true);
    window.addEventListener('resize', again);
    return () => {
      root.removeEventListener('scroll', again, true);
      window.removeEventListener('resize', again);
    };
  }, [anchor, root, phone, card]);

  // Esc and a press outside close it (a press on a tag is the tag's own: it switches or closes).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const down = (e: PointerEvent) => {
      const path = e.composedPath();
      if (ref.current && path.includes(ref.current)) return;
      if (path.some((n) => n instanceof Element && n.classList.contains('shp-stk-b'))) return;
      onClose();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', down, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', down, true);
    };
  }, [onClose]);
  // The card takes focus as it opens, so Tab walks it.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [card.pull.n, card.change.part]);

  const reviewAt = review
    ? {
        ...(pull.step ? { step: pull.step } : { path: change.files[0]!.path }),
        narrow: { part: partName, pr: pull.n, title: pull.title, ...(pull.url ? { url: pull.url } : {}), colour: shapeStackColour(stack, pull.n), files: change.files.map((f) => f.path) },
      }
    : null;

  return (
    <div
      ref={ref}
      className={`shp-stk-card${phone ? ' sheet' : ''}`}
      role="dialog"
      aria-label={`#${pull.n} in ${partName}`}
      tabIndex={-1}
      data-shp-stack-card={`${change.part}#${pull.n}`}
      style={phone ? undefined : { left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {phone && <div className="shp-stk-grip" aria-hidden="true" />}
      <div className="shp-stk-card-h">
        <PrName stack={stack} n={pull.n} />
        <button type="button" className="shp-icon-btn shp-stk-x" onClick={() => onClose()} aria-label="Close">
          ×
        </button>
      </div>
      <p className="shp-stk-card-part">
        In <b>{partName}</b>
      </p>
      <p className="shp-stk-card-said">{change.said}</p>
      <ul className="shp-stk-files" aria-label={`Files #${pull.n} changed here`}>
        {rows.map(({ file, counts }, i) => {
          const { name, dir } = stackFileName(file.path);
          return (
            <li key={file.path}>
              <button type="button" className="shp-stk-frow" onClick={() => onFile(i)} data-shp-stack-file={file.path}>
                <FileIcon />
                <span className="shp-stk-fname">{name}</span>
                <span className="shp-stk-fdir">{dir}</span>
                <Counts counts={counts} />
              </button>
            </li>
          );
        })}
      </ul>
      {(others.length > 0 || reviewAt) && (
        <div className="shp-stk-card-foot">
          {others.length > 0 && (
            <span className="shp-stk-also">
              <span>Also changed here by</span>
              {others.map((p) => (
                <button key={p.n} type="button" className="shp-stk-pr" data-c={shapeStackColour(stack, p.n)} onClick={() => onSwitch(p.n)} data-shp-stack-switch={p.n}>
                  <PrIcon />#{p.n}
                </button>
              ))}
            </span>
          )}
          {reviewAt && (
            <button
              type="button"
              className="shp-stk-read"
              data-shp-stack-review=""
              onClick={() => {
                void Promise.resolve()
                  .then(() => review!.open(reviewAt))
                  .then((ok) => {
                    if (ok) onClose(false);
                  }, () => {});
              }}
            >
              Read it in the review ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StackFile({
  stack,
  card,
  partName,
  index,
  phone,
  review,
  readFile,
  onBack,
  onClose,
  onGo,
}: {
  stack: ShapeStack;
  card: Card;
  partName: string;
  index: number;
  phone: boolean;
  review: ShapeSurfaceReview | null;
  readFile?: (path: string) => Promise<string | null>;
  onBack: () => void;
  onClose: () => void;
  onGo: (i: number) => void;
}) {
  const { rows, ready } = useFileRows(card, review);
  const row = rows[Math.min(index, rows.length - 1)]!;
  const total = rows.length;
  const [whole, setWhole] = useState<{ path: string; contents: string | null } | null>(null);
  const needWhole = ready && !row.patch && !!readFile;
  useEffect(() => {
    if (!needWhole) return;
    let live = true;
    void readFile!(row.file.path).then(
      (contents) => live && setWhole({ path: row.file.path, contents }),
      () => live && setWhole({ path: row.file.path, contents: null }),
    );
    return () => {
      live = false;
    };
  }, [needWhole, readFile, row.file.path]);

  const nav = (
    <div className="shp-stk-nav" data-shp-stack-nav="">
      <button type="button" className="shp-stk-back" onClick={onBack} aria-label={`Back to #${card.pull.n} in ${partName}`}>
        <Chevron back />
        {partName}
      </button>
      <span className="shp-stk-by">from</span>
      <PrName stack={stack} n={card.pull.n} title={!phone} />
      {total > 1 && (
        <span className="shp-stk-pager">
          <button type="button" className="shp-stk-pg" disabled={index === 0} onClick={() => onGo(index - 1)} aria-label="Previous file">
            <Chevron back />
          </button>
          <span>
            {index + 1} of {total} files
          </span>
          <button type="button" className="shp-stk-pg" disabled={index === total - 1} onClick={() => onGo(index + 1)} aria-label="Next file">
            <Chevron />
          </button>
        </span>
      )}
    </div>
  );

  if (row.patch) {
    return (
      <PopoutDialog open onClose={onClose} title={row.file.path} dataAttributes={{ 'data-shp-stack-popup': row.file.path }}>
        {nav}
        <div className="shp-diff-pop">
          <ShapePatch key={row.file.path} patch={row.patch} />
        </div>
      </PopoutDialog>
    );
  }
  if (whole && whole.path === row.file.path && whole.contents != null) {
    return <CodeFilePopout open onClose={onClose} filepath={row.file.path} contents={whole.contents} line={row.file.lines?.[0]?.[0]} lineEnd={row.file.lines?.[0]?.[1]} headerAction={nav} />;
  }
  return (
    <PopoutDialog open onClose={onClose} title={row.file.path} dataAttributes={{ 'data-shp-stack-popup': row.file.path }}>
      {nav}
      <div className="shp-diff-pop" aria-busy={needWhole && !whole}>
        <p className="shp-stk-file-path">{row.file.path}</p>
      </div>
    </PopoutDialog>
  );
}
