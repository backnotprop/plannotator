/**
 * The one-time list options dialog (approval "inbox-list-options-intro", 2026-10-31; A-r3 with the r4 preview):
 * shaped like the Board intro. The picture is the person's own list, drawn by the real rows (InboxList's `ListRow`)
 * in a column the list's width, its bottom fading out (each thread name on one line, cut with "…"); under it a title,
 * one line and the four options of the list's ⋮ menu as switches. It opens at the list's look as it stands (the defaults, all off, for someone who never opened
 * the ⋮ menu), so Done never undoes a choice made there. Done saves the switches as shown (every list takes them at
 * once); Keep as it is and Escape change nothing. App retires it either way (the Inbox's claim, once per machine).
 *
 * As it opens it plays a short preview (listIntro.ts `LIST_INTRO_PREVIEW`): the switches turn on one at a time and
 * the rows change, then all turn off. The switches are inert meanwhile (no pointer, no focus, out of the
 * accessibility tree, so a screen reader never hears them flip), drawn as usual. Any key, click or touch ends it at
 * once and snaps back to where it opened; the input still does its normal job (so the first Tab reaches the
 * switches). None under reduced motion.
 *
 * It is drawn light for everyone, whatever the person's mode (the owner, 2026-10-31): the dialog is a light scope on
 * the person's own light palette (`lightScope`), so the window's tokens are worked out again inside it. The window
 * behind keeps its mode.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { InboxListRow, InboxSectionId } from '@plannotator/core/inbox-types';
import { listLookClasses, LIST_LOOK_OPTIONS, type ListLook, type ListLookKey } from '../listLook';
import { LIST_INTRO_PREVIEW, LIST_INTRO_SWAP_MS } from '../listIntro';
import { ListRow } from './InboxList';
import { Modal } from './Updates';
import { Icon } from '../icons';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { themeSupportsHalf } from '@plannotator/ui/utils/themeRegistry';

/**
 * The classes that make an element a light scope of the window: the window's root class (its tokens are worked out
 * again there), the palette the person picked for light mode (Plannotator's own if that one cannot draw light) and
 * `light`, as ThemeProvider puts them on <html> in light mode.
 */
export function lightScope(lightTheme: string): string {
  return `pn-inbox theme-${themeSupportsHalf(lightTheme, 'light') ? lightTheme : 'plannotator'} light`;
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

/** The picture: the list column as it stands beside a thread (or a phone's list), with `look`. Not interactive. */
function PreviewList({ groups, projectNames, awayMachines, look, phone }: { groups: readonly ListIntroGroup[]; projectNames?: ReadonlyMap<string, string>; awayMachines?: ReadonlySet<string>; look: ListLook; phone: boolean }) {
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
  return (
    <section ref={section} className={`ib-listcol${phone ? '' : ' ib-narrow'} ib-lo-list${classes}`} aria-hidden="true" data-list-intro-preview="">
      {!phone && (
        <div className="ib-lhead">
          <h1 dir="auto">Inbox</h1>
          <span className="ib-tidytrig ib-lhead-more">
            <Icon name="dots" size={18} />
          </span>
        </div>
      )}
      <div className="ib-lbody">
        {groups.map((group) => (
          <div className="ib-group" data-section-id={group.id} key={group.id}>
            <div className="ib-band">
              {group.label} <span className="ib-n">{group.count}</span>
              {group.id === 'quiet' && <Icon name="chevR" size={14} />}
            </div>
            {group.id !== 'quiet' &&
              group.rows.map((row) => (
                <ListRow
                  key={row.thread_id}
                  row={row}
                  project={projectNames?.get(row.project.id) ?? row.project.name}
                  away={!!row.machine && (awayMachines?.has(row.machine) ?? false)}
                  drawn={group.id}
                  shape={phone ? 'phone' : 'narrow'}
                  full={false}
                  filtered={false}
                  selected={false}
                  lit={false}
                  onOpen={noop}
                  day=""
                  menu={false}
                  pinned={false}
                  pill={look.highlight}
                  compact={look.compact}
                />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The preview as the dialog opens: true while it plays. Every step goes through `set`; the end (or any key, click
 * or touch) puts back the look it opened at. A key ends it synchronously, before the key reaches the dialog, so the
 * switches are no longer inert when a first Tab moves focus.
 */
function usePreview(set: (key: ListLookKey, on: boolean) => void, reset: () => void): boolean {
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const latest = useRef({ set, reset });
  latest.current = { set, reset };
  useEffect(() => {
    if (!playing) return;
    const timers = LIST_INTRO_PREVIEW.map((step) =>
      setTimeout(() => {
        if (step.key) latest.current.set(step.key, true);
        else {
          latest.current.reset();
          setPlaying(false);
        }
      }, step.at),
    );
    const stop = () => {
      for (const timer of timers) clearTimeout(timer);
      flushSync(() => {
        latest.current.reset();
        setPlaying(false);
      });
    };
    window.addEventListener('keydown', stop, true);
    window.addEventListener('pointerdown', stop, true);
    return () => {
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener('keydown', stop, true);
      window.removeEventListener('pointerdown', stop, true);
    };
  }, [playing]);
  return playing;
}

export interface ListLookIntroProps {
  groups: readonly ListIntroGroup[];
  /** The list's look as it stands (the ⋮ menu's options): the switches open at it and the preview returns to it. */
  initial: ListLook;
  projectNames?: ReadonlyMap<string, string>;
  /** Linked machines that are away (machines.ts): their rows are greyed, as in the list. */
  awayMachines?: ReadonlySet<string>;
  phone: boolean;
  /** Done: the switches as they stand. */
  onDone: (look: ListLook) => void;
  /** Keep as it is, or Escape: nothing changes. */
  onKeep: () => void;
}

export function ListLookIntro({ groups, initial, projectNames, awayMachines, phone, onDone, onKeep }: ListLookIntroProps) {
  const [opened] = useState(initial);
  const [look, setLook] = useState<ListLook>(opened);
  const set = (key: ListLookKey, on: boolean) => setLook((current) => (current[key] === on ? current : { ...current, [key]: on }));
  const playing = usePreview(set, () => setLook(opened));
  const base = useId();
  const { lightTheme } = useTheme();
  return (
    <Modal labelledBy="ib-lo-title" describedBy="ib-lo-desc" testId="list-look-intro" onClose={onKeep} ownKeys className={`ib-lo${phone ? ' ib-lo-phone' : ''} ${lightScope(lightTheme)}`}>
      <div className="ib-lo-art">
        <div className="ib-lo-frame" inert>
          <PreviewList groups={groups} projectNames={projectNames} awayMachines={awayMachines} look={look} phone={phone} />
        </div>
      </div>
      <div className="ib-lo-text">
        <h2 id="ib-lo-title">Choose how your list looks</h2>
        <p id="ib-lo-desc">You can change these later from ⋮ above the list.</p>
      </div>
      {/* While the preview plays the switches are inert: drawn as usual, never reached, never announced. */}
      <div className="ib-lo-sw" role="group" aria-label="List options" inert={playing} data-list-intro-playing={playing ? '' : undefined}>
        {LIST_LOOK_OPTIONS.map((option) => (
          <label key={option.key} className="ib-lo-opt" htmlFor={`${base}-${option.key}`}>
            <span id={`${base}-${option.key}-l`}>{option.label}</span>
            <button
              type="button"
              role="switch"
              id={`${base}-${option.key}`}
              className="ib-sw"
              aria-checked={look[option.key]}
              aria-labelledby={`${base}-${option.key}-l`}
              onClick={() => set(option.key, !look[option.key])}
              data-list-intro-option={option.key}
            />
          </label>
        ))}
      </div>
      <div className="ib-lo-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onKeep} data-list-intro-keep="">
          Keep as it is
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri" onClick={() => onDone(look)} data-list-intro-done="">
          Done
        </button>
      </div>
    </Modal>
  );
}
