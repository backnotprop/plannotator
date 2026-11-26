/**
 * The plan page's header (approval "inbox-plan-page-header-a3", .product/approved/inbox-plan-page-header-a3/):
 * the document's own title is the header.
 *
 * - A phone: one slim top bar, nothing stacked under it (the owner, 26 Nov: "It's just stacked, unstacked,
 *   unstacked"). It holds the project, then at its end (`marks`, filled by the document) Approve while it is offered
 *   or Done and Cancel while editing, the decision's mark (PlanDecision.tsx) and the history clock, then Share and one
 *   menu (`PlanMenu`, "Page actions"). The document's own title is the first thing under the bar; once it scrolls
 *   away the bar takes the plan's name (`PlanBarTitle`), a button that opens Versions. A document whose first block is
 *   not a level-1 heading with the plan's name has the bar's name from the start. An older version or a comparison
 *   says so in the bar's place for the name (`line`). Tools, comments and Send are one bar at the bottom
 *   (PlanAnnotate.tsx). The menu holds what the file-name row and the chips held: Edit, Global comment, Files,
 *   Contents, Copy file, Download, Close; on an older version, Back to version 4 and Restore v2 first.
 * - A computer: the bar stays pinned at the card's top (PlanBar.tsx: Approve, the decision's mark, the pencil, the
 *   clock), with the menu at its end: Copy file, Download, Full screen. The tools, Global comment, comments and Send
 *   are the bottom bar.
 *
 * DocLoaded (PlanPage.tsx) knows the document's actions; the top bar (PlanLoaded) draws the phone's menu, so the
 * document hands them up through `PlanChromeContext`.
 */
import { createContext, useContext, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@plannotator/ui/components/ui/dropdown-menu';
import { BottomSheet } from '../components/BottomSheet';
import { Icon, type IconName } from '../icons';
import type { PaneHostHandle } from '../parts/paneHost';

/** What the document on screen offers the page's menu (null: not offered there). */
export interface PlanDocActs {
  /** An older version on screen (a phone): back to the newest ("Back to version 4"), and its Restore ("Restore v2"). */
  older: { head: number; shown: number; back: () => void; restore: (() => void) | null } | null;
  edit: (() => void) | null;
  /** A phone while editing: Versions, whose clock gives way in the bar to Done and Cancel. */
  versions: (() => void) | null;
  /** The Markdown file pane's Viewer actions (Global comment, Copy file). */
  pane: MutableRefObject<PaneHostHandle | null> | null;
  contents: ((back: HTMLElement | null) => void) | null;
  download: { href: string; name: string } | null;
  full: (() => void) | null;
}

/**
 * The phone's bar: the main page's newest version is read (`a3`: the document's title is the header), the version on
 * screen, whether the title is out of view (null until the document is there to measure: the bar shows neither name
 * nor project moving meanwhile), and the words for an older version or a comparison (`line`).
 */
export interface PlanBarState {
  a3: boolean;
  shown: number | null;
  away: boolean | null;
  line: string | null;
}

interface PlanChrome {
  acts: MutableRefObject<PlanDocActs | null>;
  setBar: (update: (bar: PlanBarState) => PlanBarState) => void;
  /** A phone: the top bar's end, where the document draws Approve, the decision's mark and the clock. */
  marks: HTMLElement | null;
}

export const PlanChromeContext = createContext<PlanChrome | null>(null);
export const usePlanChrome = () => useContext(PlanChromeContext);

export interface PlanMenuItem {
  key: string;
  icon: IconName;
  label: string;
  /** Quiet words at the row's end (the Files count). */
  end?: string;
  /** A link (Download) instead of an action. */
  href?: { href: string; name: string };
  /** `at`: the menu's button, where a box it opens is anchored and where focus goes back. */
  act?: (at: HTMLElement | null) => void;
  /** A copy (Copy file): the row says "Copied!" with a check, as the Viewer's own Copy does, then the menu closes. */
  copies?: () => Promise<boolean>;
}
export type PlanMenuEntry = PlanMenuItem | '-';

/**
 * The menu's rows, in their order (frequency first, Close last), groups split by a line; a row is left out when the
 * page has nothing for it. A phone: Edit, Global comment / Files, Contents / Copy file, Download / Close. A computer:
 * Copy file, Download, Full screen (the rest stays on screen).
 */
export function planMenuItems(o: { phone: boolean; acts: PlanDocActs | null; files: { count: number; open: () => void } | null; close: () => void }): PlanMenuEntry[] {
  const { acts } = o;
  const pane = acts?.pane ?? null;
  const edit: PlanMenuItem | null = acts?.edit ? { key: 'edit', icon: 'pen', label: 'Edit', act: acts.edit } : null;
  const global: PlanMenuItem | null = pane ? { key: 'global', icon: 'globe', label: 'Global comment', act: (at) => void (at && pane.current?.globalComment(at)) } : null;
  const files: PlanMenuItem | null = o.files ? { key: 'files', icon: 'folder', label: 'Files', end: String(o.files.count), act: o.files.open } : null;
  const contents: PlanMenuItem | null = acts?.contents ? { key: 'contents', icon: 'contents', label: 'Contents', act: acts.contents } : null;
  const copy: PlanMenuItem | null = pane ? { key: 'copy', icon: 'copy', label: 'Copy file', copies: () => pane.current?.copy() ?? Promise.resolve(false) } : null;
  const download: PlanMenuItem | null = acts?.download ? { key: 'download', icon: 'download', label: 'Download', href: acts.download } : null;
  const full: PlanMenuItem | null = acts?.full ? { key: 'full', icon: 'frame', label: 'Full screen', act: acts.full } : null;
  const close: PlanMenuItem = { key: 'close', icon: 'x', label: 'Close', act: o.close };
  const older = acts?.older ?? null;
  const back: PlanMenuItem | null = older ? { key: 'newest', icon: 'back', label: `Back to version ${older.head}`, act: older.back } : null;
  const restore: PlanMenuItem | null = older?.restore ? { key: 'restore', icon: 'restart', label: `Restore v${older.shown}`, act: older.restore } : null;
  const versions: PlanMenuItem | null = acts?.versions ? { key: 'versions', icon: 'clock', label: 'Versions', act: acts.versions } : null;
  const groups: (PlanMenuItem | null)[][] = o.phone ? [[back, restore, versions], [edit, global], [files, contents], [copy, download], [close]] : [[copy, download, full]];
  const out: PlanMenuEntry[] = [];
  for (const group of groups) {
    const rows = group.filter((row): row is PlanMenuItem => row !== null);
    if (rows.length === 0) continue;
    if (out.length > 0) out.push('-');
    out.push(...rows);
  }
  return out;
}

/** How long a copy's row says "Copied!" before the menu closes. */
export const PLAN_COPIED_MS = 1000;

/** "Page actions" (the frame's name for the page's group): a phone's bottom sheet, a computer's menu. */
export function PlanMenu({ phone, items }: { phone: boolean; items: () => PlanMenuEntry[] }) {
  // A row acts with the page's handlers as they are when it is pressed (a new version may have come while it was open).
  const now = (row: PlanMenuItem): PlanMenuItem => items().find((r): r is PlanMenuItem => r !== '-' && r.key === row.key) ?? row;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const copy = (row: PlanMenuItem) =>
    void now(row).copies?.().then((ok) => {
      if (!ok) return setOpen(false);
      setCopied(row.key);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        setCopied(null);
        setOpen(false);
      }, PLAN_COPIED_MS);
    });
  const iconOf = (row: PlanMenuItem): IconName => (copied === row.key ? 'check' : row.icon);
  const labelOf = (row: PlanMenuItem) => (copied === row.key ? 'Copied!' : row.label);
  // The sheet is drawn inside the Inbox's own root, so its rules (icons, lines) and tokens apply to it.
  const [host, setHost] = useState<HTMLElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const shown = items();
  if (!shown.some((row) => row !== '-')) return null;
  if (!phone) {
    return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<button type="button" ref={button} className="ib-iconbtn ib-plan-more" aria-label="Page actions" data-plan-more="" />}>
          <Icon name="dots" size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-[12rem]" data-plan-menu="">
          {shown.map((row, i) =>
            row === '-' ? (
              <DropdownMenuSeparator key={`line-${i}`} />
            ) : row.href ? (
              <DropdownMenuItem key={row.key} className="text-xs" render={<a href={row.href.href} download={row.href.name} />} data-plan-menu-row={row.key}>
                <Icon name={row.icon} size={15} className="ib-glyph" />
                <span className="flex-1">{row.label}</span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={row.key} className="text-xs" closeOnClick={!row.copies} onClick={() => (row.copies ? copy(row) : now(row).act?.(button.current))} data-plan-menu-row={row.key} data-copied={copied === row.key ? '' : undefined}>
                <Icon name={iconOf(row)} size={15} className="ib-glyph" />
                <span className="flex-1">{labelOf(row)}</span>
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  // A row closes the sheet first (focus goes back to the menu's button), then acts from there.
  const pick = (row: PlanMenuItem) => {
    setOpen(false);
    requestAnimationFrame(() => now(row).act?.(button.current));
  };
  return (
    <>
      <button ref={button} type="button" className="ib-iconbtn ib-plan-more" aria-label="Page actions" aria-haspopup="dialog" aria-expanded={open} onClick={() => {
          setHost(button.current?.closest<HTMLElement>('.pn-inbox') ?? null);
          setOpen(true);
        }}
        data-plan-more=""
      >
        <Icon name="dots" size={18} />
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Page actions" host={host} attrs={{ 'data-plan-menu': '' }}>
        <div className="ib-sheet-list ib-plan-menu-list">
          {shown.map((row, i) => {
            if (row === '-') return <div key={`line-${i}`} className="ib-sheet-line" aria-hidden="true" />;
            const inner = (
              <>
                <span className="ib-sheet-lead">
                  <Icon name={iconOf(row)} size={20} />
                </span>
                <span className="ib-sheet-words">
                  <span className="ib-sheet-t">{labelOf(row)}</span>
                </span>
                {row.end && <span className="ib-sheet-end ib-plan-menu-end">{row.end}</span>}
              </>
            );
            return row.href ? (
              <a key={row.key} className="ib-sheet-row" href={row.href.href} download={row.href.name} onClick={() => setOpen(false)} data-plan-menu-row={row.key}>
                {inner}
              </a>
            ) : (
              <button key={row.key} type="button" className="ib-sheet-row" onClick={() => (row.copies ? copy(row) : pick(row))} data-plan-menu-row={row.key} data-copied={copied === row.key ? '' : undefined}>
                {inner}
              </button>
            );
          })}
        </div>
      </BottomSheet>
    </>
  );
}

/**
 * The phone's bar: the project while the document's title is on screen; once it is not, the plan's name, one button
 * that opens Versions (the two cross-fade; reduced motion: a cut). The first measurement is a cut too (`data-settled`
 * comes after it), so the page never opens on a fade. The decision is the bar's own mark, not words here.
 */
export function PlanBarTitle({ rest, name, away, shown, versionsOpen, onVersions }: { rest: string; name: string; away: boolean | null; shown: number | null; versionsOpen: boolean; onVersions: (open: boolean) => void }) {
  const spoken = [name, shown === null ? null : `Version ${shown}`, 'Versions'].filter(Boolean).join('. ');
  const known = away !== null;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!known) {
      setSettled(false);
      return;
    }
    if (settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [known, settled]);
  return (
    <div className="ib-plan-bartitle" data-away={away ? '' : undefined} data-settled={settled ? '' : undefined} data-plan-bartitle="">
      <span className="ib-plan-bartitle-rest" aria-hidden={away ? true : undefined} data-plan-bartitle-rest="">
        {rest}
      </span>
      <button type="button" className="ib-plan-titleblock" inert={away ? undefined : true} aria-expanded={versionsOpen} aria-label={spoken} onClick={() => onVersions(!versionsOpen)} data-plan-titleblock="">
        <span className="ib-plan-title-n">{name}</span>
        <Icon name="chevD" size={11} />
      </button>
    </div>
  );
}

const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Whether the document's own title is out of view in `scroll` (the file pane's `.ib-docscroll`): true when its first
 * block is not a level-1 heading with the plan's name (the bar has the name from the start), or that heading has
 * scrolled above the scroll's top edge. Null while the document has no block yet (not known).
 */
export function titleAway(scroll: HTMLElement, name: string): boolean | null {
  const first = scroll.querySelector<HTMLElement>('[data-block-id]');
  if (!first) return null;
  if (first.tagName !== 'H1' || plain(first.textContent) !== plain(name)) return true;
  return first.getBoundingClientRect().bottom < scroll.getBoundingClientRect().top + 4;
}

/** Follows `titleAway` in `root`'s document scroll (its scroll, its text arriving, its size) while `on`. */
export function useTitleAway(root: HTMLElement | null, name: string, on: boolean, report: ((away: boolean) => void) | null) {
  useEffect(() => {
    if (!root || !on || !report) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scroll = root.querySelector<HTMLElement>('.ib-docscroll');
        const away = scroll ? titleAway(scroll, name) : null;
        if (away !== null) report(away);
      });
    };
    check();
    root.addEventListener('scroll', check, { capture: true, passive: true });
    const mutations = new MutationObserver(check);
    mutations.observe(root, { childList: true, subtree: true });
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    size?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('scroll', check, { capture: true });
      mutations.disconnect();
      size?.disconnect();
    };
  }, [root, name, on, report]);
}
