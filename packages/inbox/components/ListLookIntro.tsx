/**
 * "Choose how your list looks" (approval "inbox-rows-dialog", round 7b; it replaced the switches of approval
 * "inbox-list-options-intro", shipped in 0.28.42). A one-time dialog: the picture of an Inbox with example projects
 * plays a short demo of letter marks and logos and holds on the stacked look (RowsIntroPicture.tsx); under it three
 * looks, Minimal, Balanced and Detailed (Settings → Rows' presets, RowsSettings.tsx `ROWS_PRESETS`), each with a
 * sketch. Nothing is picked when it opens; the person's look is marked "Current". Picking a look raises a card over
 * the blurred picture with the person's own rows in that look. Done (disabled until a pick) saves the look; Keep as it
 * is and Escape change nothing; "Customize rows" opens Settings → Rows. App retires it either way (the Inbox's claim).
 *
 * The dialog follows the person's mode, the picture too (the owner, q-fd707b9e). `PreviewList` and `lightScope` stay
 * here for the other dialogs that draw the person's rows in a light picture (ListViewIntro, VoiceIntro).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import type { InboxListGroupId, InboxListRow, InboxSectionId } from '@plannotator/core/inbox-types';
import { listLookClasses, type ListLook } from '../listLook';
import { LIST_INTRO_SWAP_MS, ROWS_INTRO_END_MS, ROWS_INTRO_STEPS_MS, rowsIntroScene } from '../listIntro';
import { RowMarksScope } from '../letterMarks';
import { ListRow } from './InboxList';
import { Modal } from './Updates';
import { ROWS_PRESETS, rowsPreset, type RowsPreset } from './RowsSettings';
import { RowsIntroNotes, RowsIntroWindow } from './RowsIntroPicture';
import { Icon } from '../icons';
import { themeSupportsHalf } from '@plannotator/ui/utils/themeRegistry';

/**
 * The classes that make an element a light scope of the window: `ib-lightscope` (the window's token blocks name it,
 * so its tokens are worked out again there; it is not a `.pn-inbox`, so the window's layout rules and portals never
 * reach it), the palette the person picked for light mode (Plannotator's own if that one cannot draw light) and
 * `light`, as ThemeProvider puts them on <html> in light mode.
 */
export function lightScope(lightTheme: string): string {
  return `ib-lightscope theme-${themeSupportsHalf(lightTheme, 'light') ? lightTheme : 'plannotator'} light`;
}

/** The list's groups as drawn (Quiet folded: its band only). `count`: the group's threads (`rows` may be fewer). */
export interface ListIntroGroup {
  id: InboxSectionId;
  label: string;
  count: number;
  rows: readonly InboxListRow[];
}

const noop = () => {};
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * The picture: the list column as it stands beside a thread (or a phone's list), with `look`. Not interactive. With
 * `flat`, the List view's one run of rows instead of the groups (the List view's choice dialog, ListViewIntro.tsx);
 * `head: false` leaves out the list header.
 */
export function PreviewList({ groups, flat, projectNames, awayMachines, look, phone, head = true }: { groups: readonly ListIntroGroup[]; flat?: readonly { row: InboxListRow; drawn: InboxListGroupId }[]; projectNames?: ReadonlyMap<string, string>; awayMachines?: ReadonlySet<string>; look: ListLook; phone: boolean; head?: boolean }) {
  const section = useRef<HTMLElement>(null);
  const classes = listLookClasses(look);
  const shownLook = useRef(classes);
  // Each change of look: the rows swap with a short opacity crossfade, never a morph (none under reduced motion).
  useLayoutEffect(() => {
    if (shownLook.current === classes) return;
    shownLook.current = classes;
    if (reducedMotion()) return;
    section.current?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: LIST_INTRO_SWAP_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }, [classes]);
  const previewRow = (row: InboxListRow, drawn: InboxListGroupId) => (
    <ListRow
      key={row.thread_id}
      row={row}
      project={projectNames?.get(row.project.id) ?? row.project.name}
      away={!!row.machine && (awayMachines?.has(row.machine) ?? false)}
      drawn={drawn}
      shape={phone ? 'phone' : 'narrow'}
      full={false}
      filtered={false}
      selected={false}
      lit={false}
      onOpen={noop}
      day=""
      menu={false}
      pinned={false}
      pinColumn={false}
      pill={look.highlight}
      compact={look.compact}
    />
  );
  return (
    <section ref={section} className={`ib-listcol${phone ? '' : ' ib-narrow'} ib-lo-list${classes}`} aria-hidden="true" data-list-intro-preview="">
      {!phone && head && (
        <div className="ib-lhead">
          <h1 dir="auto">Inbox</h1>
          <span className="ib-tidytrig ib-lhead-more">
            <Icon name="dots" size={18} />
          </span>
        </div>
      )}
      <div className="ib-lbody">
        {flat ? (
          <div className="ib-group" data-section-id="list" data-flat-list="">
            {flat.map(({ row, drawn }) => previewRow(row, drawn))}
          </div>
        ) : (
          groups.map((group) => (
            <div className="ib-group" data-section-id={group.id} key={group.id}>
              <div className="ib-band">
                {group.label} <span className="ib-n">{group.count}</span>
                {group.id === 'quiet' && <Icon name="chevR" size={14} />}
              </div>
              {group.id !== 'quiet' && group.rows.map((row) => previewRow(row, group.id))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/**
 * The demo as the dialog opens: the time it has reached (ms), and whether it still moves. Any key, click or touch
 * jumps to the held picture at once (a key synchronously, so the key still does its job, the first Tab reaching the
 * looks). Under reduced motion it opens on the held picture.
 */
function useDemo(): { t: number; moving: boolean } {
  const [state, setState] = useState(() => (reducedMotion() ? { t: ROWS_INTRO_END_MS, moving: false } : { t: 0, moving: true }));
  const playing = state.t < ROWS_INTRO_END_MS;
  useEffect(() => {
    if (!playing) return;
    const timers = ROWS_INTRO_STEPS_MS.map((at) => setTimeout(() => setState((now) => (now.t >= at ? now : { ...now, t: at })), at));
    const stop = () => {
      for (const timer of timers) clearTimeout(timer);
      flushSync(() => setState((now) => (now.t >= ROWS_INTRO_END_MS ? now : { t: ROWS_INTRO_END_MS, moving: false })));
    };
    window.addEventListener('keydown', stop, true);
    window.addEventListener('pointerdown', stop, true);
    return () => {
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener('keydown', stop, true);
      window.removeEventListener('pointerdown', stop, true);
    };
  }, [playing]);
  return state;
}

/** The picture's drawn size, scaled to the frame's width (a phone shows the same window, smaller and taller). */
const PICTURE_W = 620;
const PICTURE_H = { desktop: 400, phone: 560 };
/** The card over the picture: at most this size, inset from the frame's edges (14 px a side, 15 above and below). */
const CARD_MAX = { w: 372, h: 320 };
/** The card's rows: the person's list, from the top. A denser look shows more of them; the card cuts the last. */
const CARD_ROWS = 7;

/** A sketch of each look's density, 40 × 32 (the mock's glyphs): Minimal two lines a thread, Balanced three, Detailed roomier with a mark beside each thread. */
function LookSketch({ look }: { look: RowsPreset }) {
  const bars =
    look === 'minimal'
      ? [4, 14, 24].map((y) => (
          <g key={y}>
            <rect x="4" y={y} width="24" height="2.6" rx="1.3" />
            <rect x="31" y={y} width="5" height="2.6" rx="1.3" opacity=".4" />
            <rect x="4" y={y + 4.2} width="3.2" height="3.2" rx="1" opacity=".55" />
            <rect x="9" y={y + 4.8} width="12" height="2" rx="1" opacity=".4" />
          </g>
        ))
      : look === 'balanced'
        ? [3, 13.5, 24].map((y) => (
            <g key={y}>
              <rect x="4" y={y} width="11" height="2" rx="1" opacity=".4" />
              <rect x="4" y={y + 3.3} width="24" height="2.6" rx="1.3" />
              <rect x="4" y={y + 7} width="31" height="2" rx="1" opacity=".4" />
            </g>
          ))
        : [3, 18].map((y) => (
            <g key={y}>
              <rect x="3" y={y + 1} width="7" height="7" rx="2" />
              <rect x="13" y={y} width="9" height="2" rx="1" opacity=".4" />
              <rect x="13" y={y + 3.4} width="20" height="4.6" rx="2.3" opacity=".75" />
              <rect x="13" y={y + 9.2} width="24" height="2" rx="1" opacity=".4" />
              <rect x="13" y={y + 12.2} width="17" height="2" rx="1" opacity=".4" />
            </g>
          ));
  return (
    <span className="ib-rl-gl" aria-hidden="true">
      <svg width="40" height="32" viewBox="0 0 40 32" fill="currentColor">
        {bars}
      </svg>
    </span>
  );
}

/** The person's rows in one look, as the list draws them (its own rows, marks and classes). */
function LookRows({ rows, look, phone, projectNames, awayMachines }: { rows: readonly { row: InboxListRow; drawn: InboxListGroupId }[]; look: ListLook; phone: boolean; projectNames?: ReadonlyMap<string, string>; awayMachines?: ReadonlySet<string> }) {
  return (
    <RowMarksScope look={look}>
      <section className={`ib-listcol${phone ? '' : ' ib-narrow'} ib-rl-list${look.hideProject ? ' ib-noproj' : ''}${listLookClasses(look)}`} aria-hidden="true">
        <div className="ib-lbody">
          <div className="ib-group">
            {rows.map(({ row, drawn }) => (
              <ListRow
                key={row.thread_id}
                row={row}
                project={projectNames?.get(row.project.id) ?? row.project.name}
                away={!!row.machine && (awayMachines?.has(row.machine) ?? false)}
                drawn={drawn}
                shape={phone ? 'phone' : 'narrow'}
                full={false}
                filtered={look.hideProject}
                selected={false}
                lit={false}
                onOpen={noop}
                day=""
                menu={false}
                pinned={false}
                pinColumn={false}
                pill={look.highlight}
                compact={look.compact}
                noPreview={look.hidePreview}
                relative={look.relativeTime}
                titleFirst={look.titleFirst}
              />
            ))}
          </div>
        </div>
      </section>
    </RowMarksScope>
  );
}

export interface ListLookIntroProps {
  /** The person's list (Quiet folded): its rows are drawn in each look on the card. */
  groups: readonly ListIntroGroup[];
  /** The list's look as it stands: the look it matches is marked "Current". */
  initial: ListLook;
  projectNames?: ReadonlyMap<string, string>;
  /** Linked machines that are away (machines.ts): their rows are greyed, as in the list. */
  awayMachines?: ReadonlySet<string>;
  phone: boolean;
  /** Done: the look picked, whole (a Settings → Rows preset). */
  onDone: (look: ListLook) => void;
  /** Keep as it is, or Escape: nothing changes. */
  onKeep: () => void;
  /** "Customize rows": Settings → Rows. Nothing is saved. */
  onCustomize: () => void;
}

export function ListLookIntro({ groups, initial, projectNames, awayMachines, phone, onDone, onKeep, onCustomize }: ListLookIntroProps) {
  const [current] = useState(() => rowsPreset(initial));
  const [pick, setPick] = useState<RowsPreset | null>(null);
  const { t, moving } = useDemo();
  const scene = rowsIntroScene(t);
  const rows = groups.filter((group) => group.id !== 'quiet').flatMap((group) => group.rows.map((row) => ({ row, drawn: group.id as InboxListGroupId }))).slice(0, CARD_ROWS);

  // The picture is drawn at a fixed size and scaled to the frame; the card sits in the frame's middle.
  const frame = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ s: 1, h: PICTURE_H.desktop, top: 0, w: CARD_MAX.w, ch: CARD_MAX.h });
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth || PICTURE_W;
      const s = Math.min(1, width / PICTURE_W);
      const h = Math.round((phone ? PICTURE_H.phone : PICTURE_H.desktop) * s);
      const w = Math.min(CARD_MAX.w, width - 28);
      const ch = Math.min(CARD_MAX.h, h - 30);
      setFit((was) => (was.s === s && was.h === h && was.top === el.offsetTop && was.w === w && was.ch === ch ? was : { s, h, top: el.offsetTop, w, ch }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [phone]);

  const choose = (id: RowsPreset) => setPick(id);
  const chosen = pick ? ROWS_PRESETS.find((preset) => preset.id === pick)! : null;
  return (
    <Modal labelledBy="ib-lo-title" describedBy="ib-lo-desc" testId="list-look-intro" onClose={onKeep} ownKeys initialFocus=".ib-rl-looks" className={`ib-lo ib-rl${phone ? ' ib-lo-phone' : ''}`}>
      <div className="ib-rl-art" data-preview={pick ?? undefined} data-moving={moving ? '' : undefined} style={{ '--rl-s': fit.s, '--rl-fh': `${fit.h}px` } as CSSProperties}>
        <p className="ib-rl-cap" aria-hidden="true">
          <span data-on={pick ? undefined : ''}>Example projects</span>
          <span data-on={pick ? '' : undefined}>Your list</span>
        </p>
        <div ref={frame} className="ib-rl-frame" inert aria-hidden="true" data-list-intro-picture="" data-scene={scene.held ? 'held' : scene.marks}>
          <RowsIntroWindow scene={scene} moving={moving} />
        </div>
        <RowsIntroNotes shown={scene.card} moving={moving} />
        <div className="ib-rl-veil" aria-hidden="true" />
        {/* The picked look, on the person's own rows: one layer per look, so a change of look crossfades. */}
        <div className="ib-rl-card" inert aria-hidden="true" data-list-intro-card={pick ?? undefined} style={{ width: fit.w, height: fit.ch, top: fit.top + Math.round((fit.h - fit.ch) / 2) }}>
          <div className="ib-rl-ch">Inbox</div>
          <div className="ib-rl-cls">
            {ROWS_PRESETS.map((preset) => (
              <div key={preset.id} className="ib-rl-cl" data-look={preset.id} data-on={pick === preset.id ? '' : undefined}>
                <LookRows rows={rows} look={preset.look} phone={phone} projectNames={projectNames} awayMachines={awayMachines} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="ib-lo-text">
        <h2 id="ib-lo-title">Choose how your list looks</h2>
        <p id="ib-lo-desc">
          Pick a look. Fine-tune it any time in{' '}
          <button type="button" className="ib-rl-link" onClick={onCustomize} data-list-intro-customize="">
            Customize rows
          </button>
          , from ⋮ above the list.
        </p>
      </div>
      <div className="ib-rl-looks" role="radiogroup" aria-labelledby="ib-lo-title" tabIndex={-1}>
        {ROWS_PRESETS.map((preset) => (
          <label key={preset.id} className="ib-rl-look" data-on={pick === preset.id ? '' : undefined} data-list-intro-look={preset.id}>
            <input type="radio" name="ib-rl-look" value={preset.id} checked={pick === preset.id} onChange={() => choose(preset.id)} />
            <LookSketch look={preset.id} />
            <span className="ib-rl-ln">
              {preset.label}
              {current === preset.id && <span className="ib-rl-cur">Current</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="ib-lo-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onKeep} data-list-intro-keep="">
          Keep as it is
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri" disabled={!chosen} onClick={() => chosen && onDone(chosen.look)} data-list-intro-done="">
          Done
        </button>
      </div>
    </Modal>
  );
}
