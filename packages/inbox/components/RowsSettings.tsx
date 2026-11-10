/**
 * Settings → Rows (`#settings/rows`, opened from the list's ⋮ "Customize rows…"; approval
 * "inbox-rows-settings-page", 2026-11-10, which replaced the flat form of "inbox-customize-rows"). "Your list": the
 * person's own newest rows, drawn by the list's own row (`ListRow`), stays in view while they choose: beside the
 * controls on a wide page, pinned at the top on a phone (two rows, the two that show the last change best). Labelled
 * examples stand in when there are no threads. Beside it: four looks to start from (Balanced = the defaults, Dense,
 * Minimal, Detailed), eight choices, and nine more under "More choices". Every change says what it was beside the
 * list's title ("Changed: Spacing → Compact", with Undo); a small change also tints the part of the rows that moved
 * for a moment (not under reduced motion, and not a change that re-lays the whole row). Undo, in the header too, steps back through this visit's changes; Reset to default is
 * Balanced.
 *
 * Every control is the list's look (listLook.ts) through the control model (rowsControls.ts): a change shows at once
 * and is saved for the person (config.json `inboxRows`), and every list in every window takes it. The page reads the
 * look and never writes it on open; only a press writes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RowMarksScope } from '../letterMarks';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import { LIST_LOOK_DEFAULT, LIST_LOOK_KEYS, isDefaultListLook, listLookClasses, lookWithChange, useListLook, type ListLook } from '../listLook';
import { ROWS_MAIN_CONTROLS, ROWS_MORE_CONTROLS, ROWS_PRESETS, lookWithChoice, rowsChangeWords, rowsChangedControls, rowsPreset, type RowsControl, type RowsControlId } from '../rowsControls';
import { ListRow } from './InboxList';
import { Icon } from '../icons';

export { ROWS_PRESETS, rowsPreset, type RowsPreset } from '../rowsControls';

/** The looks the one-time "Choose how your list looks" dialog offers (ListLookIntro.tsx), in its order. */
export const ROWS_INTRO_PRESETS = (['minimal', 'balanced', 'detailed'] as const).map((id) => ROWS_PRESETS.find((preset) => preset.id === id)!);

/** A row of the person's list for the pictures, with the group it is drawn in. */
export interface RowsPreviewRow {
  row: InboxListRow;
  drawn: InboxListGroupId;
}

/** How many of the person's rows "Your list" draws: beside the controls, and pinned on a phone. */
const PREVIEW_ROWS = 6;
const PHONE_ROWS = 2;
/** A preset's picture: the first rows, at half size. */
const PRESET_ROWS = 2;
/** How long a changed part stays tinted (inbox.css `ib-rws-flash-*`), with a little room for the fade's end. */
const FLASH_MS = 1700;

const noop = () => {};

function sample(over: Partial<InboxListRow> & Pick<InboxListRow, 'thread_id' | 'subject' | 'section' | 'last_at'>): InboxListRow {
  return {
    project_id: 'prj_sample',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_sample', name: null },
    created_at: over.last_at,
    last_author: 'agent',
    message_count: 3,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_sample', name: 'storefront' },
    thread_name: null,
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  };
}

/** The examples for someone with no threads yet: between them, every choice changes at least one. */
function exampleRows(): RowsPreviewRow[] {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const rows: InboxListRow[] = [
    sample({
      thread_id: 'rows-sample-stopped',
      project: { id: 'prj_billing', name: 'billing-svc' },
      thread_name: 'Staging database upgrade',
      subject: 'The staging password expired: can you rotate it?',
      author: { kind: 'agent', host: 'codex', session: 'ses_b', name: null },
      section: 'stopped',
      unread: true,
      questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: null },
      last_at: ago(4),
    }),
    sample({
      thread_id: 'rows-sample-named',
      thread_name: 'Cart page refresh',
      subject: 'Which cart layout should ship first?',
      participants: [
        { host: 'claude-code', session: 'ses_a' },
        { host: 'codex', session: 'ses_c' },
      ],
      section: 'waiting',
      unread: true,
      questions: { open: 2, picked: 0, stopped: false, holds_up: [], prompt: null },
      pulls: { count: 1, headline: { key: 'github.com/example/storefront#412', state: 'open' } },
      last_at: ago(10),
    }),
    sample({
      thread_id: 'rows-sample-new',
      project: { id: 'prj_docs', name: 'docs-site' },
      subject: 'Install guide rewritten',
      author: { kind: 'agent', host: 'opencode', session: 'ses_o', name: null },
      section: 'new',
      waiting_on_person: false,
      unread: true,
      last_at: ago(42),
    }),
    sample({
      thread_id: 'rows-sample-drift',
      project: { id: 'prj_infra', name: 'infra' },
      thread_name: 'Nightly Terraform drift',
      subject: 'Drift in three modules; nothing to answer yet',
      section: 'new',
      waiting_on_person: false,
      pulls: { count: 3, headline: { key: 'github.com/example/infra#88', state: 'draft' } },
      last_at: ago(68),
    }),
    sample({
      thread_id: 'rows-sample-plain',
      subject: 'Tests pass on main after the retry fix',
      author: { kind: 'agent', host: 'pi', session: 'ses_p', name: null },
      section: 'quiet',
      waiting_on_person: false,
      pulls: { count: 1, headline: { key: 'github.com/example/storefront#409', state: 'merged' } },
      last_at: ago(60 * 26),
    }),
  ];
  return rows.map((row) => ({ row, drawn: row.section }));
}

/**
 * Whether a row has the part a choice changes, so a phone's two rows can be ones that show it. The parts every row
 * has (its spacing, its time) are true for all, which keeps the newest two.
 */
function rowShows(control: RowsControlId, row: InboxListRow): boolean {
  switch (control) {
    case 'pulls':
      return !!row.pulls;
    case 'preview':
      return row.thread_name !== null;
    case 'needs':
      return row.questions.open > 0 || row.section === 'quiet';
    case 'newer':
      return row.unread;
    default:
      return true;
  }
}

/**
 * Where a small change shows on a row: the parts to tint (the list's own classes: InboxList.tsx, letterMarks.tsx,
 * threadPulls/ThreadPulls.tsx). Only small changes tint (the owner, 2026-11-10: "Only for small changes: no flash
 * when the whole row changes"): a choice that is not here re-lays every row (Spacing, First on the row, Lines between
 * rows), as a look from "Start from" and Reset do, and tints nothing; the change line says it.
 */
const FLASH_PARTS: Partial<Record<RowsControlId, readonly string[]>> = {
  preview: ['.ib-pv'],
  time: ['.ib-t'],
  timeAt: ['.ib-t'],
  needs: ['.ib-qn, .ib-stm'],
  agents: ['.ib-atiles'],
  project: ['.ib-p'],
  pulls: ['.ib-prmark'],
  newer: ['.ib-title, .ib-m2'],
  boldAll: ['.ib-title, .ib-m2'],
  pill: ['.ib-title, .ib-m2'],
  badges: ['.ib-lm, .ib-lm-dot'],
  shape: ['.ib-lm, .ib-lm-dot'],
  logo: ['.ib-lm, .ib-lm-dot'],
  github: ['.ib-lm, .ib-lm-dot'],
};
/**
 * A part that just left has nothing to tint: the line it was on says so instead (first selector that finds any). A PR
 * mark's only in the rows that had one. Badges turned off tint nothing.
 */
const FLASH_GONE: Partial<Record<RowsControlId, readonly string[]>> = {
  pulls: ['.ib-l3, .ib-l4, .ib-m3', '.ib-l2-lead, .ib-m1-lead', '.ib-l1, .ib-m1'],
  agents: ['.ib-from'],
  project: ['.ib-from'],
  preview: ['.ib-title, .ib-m2'],
};

/** The person's rows in one look, by the list's own row. Not interactive, not announced. */
function LookList({ rows, look, phone, examples, projectNames, awayMachines, className = '' }: { rows: readonly RowsPreviewRow[]; look: ListLook; phone: boolean; examples: boolean; projectNames?: ReadonlyMap<string, string>; awayMachines?: ReadonlySet<string>; className?: string }) {
  return (
    // The examples' projects have no pictures: their badges are letters (`pictures` off asks the Inbox for none).
    <RowMarksScope look={look} pictures={!examples}>
      <section className={`ib-listcol ib-rws-list${phone ? '' : ' ib-narrow'}${className}${look.hideProject ? ' ib-noproj' : ''}${listLookClasses(look)}`} aria-hidden="true">
        {/* The rows alone, no bands: no choice here changes a band. */}
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
                timeBelow={look.timeBelow}
                statusMark={look.statusMark}
                noAgents={look.hideAgents}
                noPulls={look.hidePulls}
              />
            ))}
          </div>
        </div>
      </section>
    </RowMarksScope>
  );
}

/** A segmented choice: a radio group named by its row's label, as Settings → General's Theme and Text size. */
function Seg({ name, labelledBy, describedBy, value, choices, onChange }: { name: string; labelledBy: string; describedBy?: string; value: string | null; choices: readonly { id: string; label: string }[]; onChange: (next: string) => void }) {
  return (
    <span className="ib-seg" role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {choices.map((choice) => (
        <label key={choice.id} className="ib-seg-o" data-on={value === choice.id ? '' : undefined}>
          <input type="radio" name={name} value={choice.id} checked={value === choice.id} onChange={() => onChange(choice.id)} />
          {choice.label}
        </label>
      ))}
    </span>
  );
}

/** One choice: its label (naming it for a screen reader), its words if any, and its segmented choice or switch. */
function ControlRow({ control, look, onChoice }: { control: RowsControl; look: ListLook; onChoice: (control: RowsControl, value: string | boolean) => void }) {
  const id = `ib-rows-${control.id}`;
  const desc = control.desc?.(look);
  const descId = desc ? `${id}-desc` : undefined;
  return (
    <div className="ib-prow" data-rows-control={control.id}>
      <span className="ib-txt">
        <span className="ib-l" id={id}>
          {control.label}
        </span>
        {desc && (
          <span className="ib-desc" id={descId}>
            {desc}
          </span>
        )}
      </span>
      <span className="ib-ctl">
        {control.kind === 'switch' ? (
          <button type="button" role="switch" className="ib-sw" aria-checked={control.get(look)} aria-labelledby={id} aria-describedby={descId} onClick={() => onChoice(control, !control.get(look))} />
        ) : (
          <Seg name={id} labelledBy={id} describedBy={descId} value={control.get(look)} choices={control.choices} onChange={(next) => onChoice(control, next)} />
        )}
      </span>
    </div>
  );
}

export interface RowsSectionProps {
  phone: boolean;
  onGeneral?: () => void;
  /** The person's list, newest first: "Your list" draws its top rows. None (or absent): the examples. */
  rows?: readonly RowsPreviewRow[];
  projectNames?: ReadonlyMap<string, string>;
  /** Linked machines that are away (machines.ts): their rows are greyed, as in the list. */
  awayMachines?: ReadonlySet<string>;
}

interface Step {
  /** The look before the change. */
  look: ListLook;
  words: string[];
  /** A whole look (a look to start from, Reset): undoing it re-lays every row too, so it tints nothing. */
  whole: boolean;
}

export function RowsSection({ phone, onGeneral, rows, projectNames, awayMachines }: RowsSectionProps) {
  const [look, set] = useListLook();
  const preset = rowsPreset(look);
  const [examples] = useState(exampleRows);
  const own = rows && rows.length > 0 ? rows : null;
  const source = own ?? examples;
  // This visit's changes, oldest first: Undo takes the last. Kept here, not saved: leaving the page forgets them.
  const [steps, setSteps] = useState<readonly Step[]>([]);
  const [last, setLast] = useState<{ words: string[]; undone: boolean } | null>(null);
  const [more, setMore] = useState(false);
  // The choices that moved in the last change (the tint), and a count so the same one twice tints twice.
  const [flash, setFlash] = useState<{ ids: readonly RowsControlId[]; n: number; tint: boolean }>({ ids: [], n: 0, tint: false });
  /**
   * A picture switch turned on while no project badges showed turned them on (listLook.ts `lookWithChange`). Until
   * the person picks the badges themselves (Letter badges, Badge shape, a look to start from, Undo), turning the
   * pictures off again puts project badges back off, so on then off is no change. Only this page's clicks: a saved
   * look reads as it always did.
   */
  const broughtProjects = useRef(false);
  const frame = useRef<HTMLDivElement>(null);

  // A phone's two rows: the newest that show the last change, else the newest.
  const lead = flash.ids[0];
  const shown = useMemo(() => {
    if (!phone) return source.slice(0, PREVIEW_ROWS);
    const telling = lead ? source.filter(({ row }) => rowShows(lead, row)) : [];
    return [...telling, ...source.filter((entry) => !telling.includes(entry))].slice(0, PHONE_ROWS);
  }, [phone, source, lead]);

  /** One change by the person: shown and saved (one save), remembered for Undo, said beside the list. */
  const apply = (next: ListLook, how: { undone?: Step; whole?: boolean } = {}) => {
    const { undone } = how;
    const whole = how.whole === true || undone?.whole === true;
    const changed = rowsChangedControls(look, next);
    const words = rowsChangeWords(look, next);
    // The look is whole and settled (`lookWithChange`), so writing it over the one on screen writes exactly it.
    set(next);
    if (undone) setSteps((all) => all.slice(0, -1));
    else setSteps((all) => [...all, { look, words, whole }]);
    setLast({ words: undone ? undone.words : words, undone: !!undone });
    // Only a small change tints: every control it moved has a part of the row to show it on.
    setFlash((was) => ({ ids: changed.map((control) => control.id), n: was.n + 1, tint: !whole && changed.every((control) => FLASH_PARTS[control.id]) }));
  };
  const same = (next: ListLook) => LIST_LOOK_KEYS.every((key) => next[key] === look[key]);
  const choose = (control: RowsControl, value: string | boolean) => {
    let next = lookWithChoice(look, control, value);
    const picture = control.id === 'logo' || control.id === 'github';
    if (picture && value === false && broughtProjects.current && !next.repoLogo && !next.githubPictures) next = lookWithChange(next, { marksProjects: false });
    if (picture) broughtProjects.current = value === true ? broughtProjects.current || !look.marksProjects : broughtProjects.current && next.marksProjects;
    else if (control.id === 'badges' || control.id === 'shape') broughtProjects.current = false;
    if (!same(next)) apply(next);
  };
  const whole = (next: ListLook) => {
    broughtProjects.current = false;
    if (!same(next)) apply(next, { whole: true });
  };
  const undo = () => {
    const step = steps.at(-1);
    if (!step) return;
    broughtProjects.current = false;
    apply(step.look, { undone: step });
  };

  // The tint: the parts a small change moved in "Your list", by the list's own classes. A fill that fades (inbox.css),
  // never an outline; reduced motion draws none. A part that left (but for a PR mark) tints nothing. Set on the frame, which React leaves alone, so a row that renders
  // again keeps it.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || !flash.tint) return;
    const found: Element[] = [];
    for (const id of flash.ids) {
      const parts = FLASH_PARTS[id]?.flatMap((selector) => [...el.querySelectorAll(selector)]) ?? [];
      if (parts.length > 0) found.push(...parts);
      else {
        // Gone: per row (a PR mark's: only the rows that had one), the last of the first lines found.
        for (const { row } of shown) {
          if (id === 'pulls' && !row.pulls) continue;
          const scope = el.querySelector(`[data-thread-id="${row.thread_id}"]`);
          const line = FLASH_GONE[id]?.map((selector) => [...(scope?.querySelectorAll(selector) ?? [])].at(id === 'pulls' ? -1 : 0)).find((part) => part);
          if (line) found.push(line);
        }
      }
    }
    // Two names for one animation: a second change while the first still fades starts it again.
    const name = `ib-rws-flash-${flash.n % 2 ? 'a' : 'b'}`;
    for (const part of found) (part as HTMLElement).dataset.rowsFlash = name;
    const timer = setTimeout(() => {
      for (const part of found) delete (part as HTMLElement).dataset.rowsFlash;
    }, FLASH_MS);
    return () => {
      clearTimeout(timer);
      for (const part of found) delete (part as HTMLElement).dataset.rowsFlash;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per change, on the rows that change drew.
  }, [flash]);

  // Under the list's title, a phone's pinned list casts a soft shadow once the page has scrolled under it.
  const pin = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = sentinel.current;
    const el = pin.current;
    if (!phone || !mark || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) el.toggleAttribute('data-stuck', !entry.isIntersecting);
    });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [phone]);

  const step = steps.at(-1);
  const line = last ? `${last.undone ? 'Undid' : 'Changed'}: ${last.words.join(', ')}` : '';
  const controlRow = (control: RowsControl) => <ControlRow key={control.id} control={control} look={look} onChoice={choose} />;
  return (
    <div className="ib-rws" data-settings-rows="" data-rows-preset={preset ?? 'none'}>
      {/* Settings draws no lede of its own for Rows: this one has Undo and Reset beside it. */}
      <div className="ib-rws-head">
        <p className="ib-lede">How each thread looks in your list. Changes show at once, everywhere you use the Inbox.</p>
        <span className="ib-rws-acts">
          <button type="button" className="ib-btn ib-ghost" data-rows-undo="" disabled={!step} title={step ? `Undo: ${step.words.join(', ')}` : undefined} onClick={undo}>
            <Icon name="reply" size={14} /> Undo
          </button>
          <button type="button" className="ib-btn" data-rows-reset="" disabled={isDefaultListLook(look)} onClick={() => whole(LIST_LOOK_DEFAULT)}>
            Reset to default
          </button>
        </span>
      </div>
      <div className="ib-rws-grid">
        <div ref={sentinel} className="ib-rws-sentinel" aria-hidden="true" />
        <div ref={pin} className="ib-rws-pv" data-rows-pinned={phone ? '' : undefined}>
          <div className="ib-rws-pvhead">
            <h2 id="ib-rows-yours">Your list</h2>
            {/* What the last change was, said to a screen reader as it happens; Undo beside it while there is one. */}
            <span className="ib-rws-last" data-rows-last="">
              <span role="status" aria-live="polite">
                {line}
              </span>
              {last && !last.undone && step && (
                <button type="button" className="ib-lnk" data-rows-undo-last="" onClick={undo}>
                  <Icon name="reply" size={13} /> Undo
                </button>
              )}
            </span>
          </div>
          <div ref={frame} className="ib-rws-frame" inert data-rows-preview={phone ? 'phone' : 'narrow'} data-rows-source={own ? 'own' : 'examples'}>
            {!own && !phone && <p className="ib-rws-empty">You have no threads yet. These examples show the look.</p>}
            <LookList rows={shown} look={look} phone={phone} examples={!own} projectNames={projectNames} awayMachines={awayMachines} />
          </div>
          {!own && phone && <p className="ib-rws-empty">You have no threads yet. These examples show the look.</p>}
        </div>
        <div className="ib-rws-ctl">
          <h2 id="ib-rows-preset">Start from</h2>
          {/* Buttons, not radios: a radio group's arrow keys choose as they move, so one stray key would wipe a look of
              the person's own. Tab reaches each, and only Enter, Space or a click applies one; the pressed one is the
              look's, and a look that matches none has none pressed. */}
          <div className="ib-rws-presets" role="group" aria-labelledby="ib-rows-preset">
            {ROWS_PRESETS.map((choice) => (
              // The picture is the list's own rows (buttons), so it sits beside the button, not in it; the button's
              // hit area covers the whole card (inbox.css).
              <div key={choice.id} className="ib-rws-pre" data-on={preset === choice.id ? '' : undefined}>
                <span className="ib-rws-pic" aria-hidden="true" inert>
                  <span className="ib-rws-pic-in">
                    <LookList rows={source.slice(0, PRESET_ROWS)} look={choice.look} phone={false} examples={!own} projectNames={projectNames} awayMachines={awayMachines} />
                  </span>
                </span>
                <button type="button" className="ib-rws-pre-n" aria-pressed={preset === choice.id} data-preset={choice.id} onClick={() => whole(choice.look)}>
                  {choice.label}
                </button>
              </div>
            ))}
          </div>
          <h2 id="ib-rows-choices">Choices</h2>
          <div className="ib-card" role="group" aria-labelledby="ib-rows-choices">
            {ROWS_MAIN_CONTROLS.map(controlRow)}
          </div>
          <button type="button" className="ib-rws-fold" aria-expanded={more} aria-controls="ib-rows-more" data-rows-more="" onClick={() => setMore((open) => !open)}>
            <Icon name="chevR" size={14} />
            More choices <span className="ib-rws-fold-n">· {ROWS_MORE_CONTROLS.length}</span>
          </button>
          <div id="ib-rows-more" hidden={!more}>
            <div className="ib-card" role="group" aria-label="More choices">
              {ROWS_MORE_CONTROLS.map(controlRow)}
            </div>
          </div>
          <div className="ib-note ib-rws-note">
            <Icon name="info" />
            <span>
              Full width keeps one line.{' '}
              {onGeneral ? (
                <>
                  Text size is in{' '}
                  <button type="button" className="ib-lnk" onClick={onGeneral}>
                    General
                  </button>
                  .
                </>
              ) : (
                'Text size is in General.'
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The phone list's value beside Rows: the preset's name, or "Custom". */
export function rowsSummary(look: ListLook): string {
  const preset = rowsPreset(look);
  return preset ? ROWS_PRESETS.find((p) => p.id === preset)!.label : 'Custom';
}

