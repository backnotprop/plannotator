/**
 * Settings → Rows (`#settings/rows`; the owner, 2026-11-02: "Take me to a settings page where I can customize how the
 * inbox rows look", opened from the list's ⋮ "Customize rows…"). Two live pictures drawn by the list's own rows
 * (`ListRow`) with fixed sample threads: "With a thread open" (the three-line row in the 380 px column) and "Full
 * width" (the one-line row, zoomed down when the page is narrower than a wide list). On a phone one picture, the
 * phone's rows. Round 2 (the owner, 2026-11-02: "Couldn't customization go a bit further"): three presets beside the
 * lede (Minimal, Balanced = the defaults, Detailed) as starting points, then beside the narrow picture Look (density,
 * first line, thread names, unread, preview, time) and Show (agent icons, project). Letter marks (approval
 * "inbox-letter-marks", 2026-11-07, all off by default): Look → Mark style, and Show → Letter marks with its two
 * picture switches, in the same cards; Detailed turns them on (Both, Avatar, no pictures). A notes-list look (the
 * owner's picture, 2026-11-07; approval "inbox-customize-rows", addendum), all off by default and in no preset: Look →
 * Time position (Top right / Under the preview), and Show → Dividers, Status mark and Bold thread names.
 *
 * Every control is the list's look (listLook.ts): a change shows at once and is saved for the person (config.json `inboxRows`), and every list in every window
 * takes it (`useListLook` listens). The pictures follow the person's mode, light or dark.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { RowMarksScope } from '../letterMarks';
import type { InboxListRow, InboxSectionId } from '@plannotator/core/inbox-types';
import { LIST_LOOK_DEFAULT, LIST_LOOK_KEYS, LIST_LOOK_OFF, listLookClasses, lookMarks, markStyleLook, marksWhatLook, useListLook, type ListLook, type ListLookKey, type MarkStyle, type MarksWhat } from '../listLook';
import { ListRow } from './InboxList';
import { Icon } from '../icons';

/** The width a wide list needs for its one-line rows (InboxList `WIDE_ROWS_MIN_LIST_WIDTH`): the picture zooms below it. */
const WIDE_PREVIEW_PX = 900;

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
    project: { id: 'prj_sample', name: 'plannotator' },
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

/** The sample threads: each control changes at least one of them. Times are a few minutes ago, so they read today. */
function sampleGroups(): { id: InboxSectionId; label: string; rows: InboxListRow[] }[] {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  return [
    {
      id: 'stopped',
      label: 'Stopped on you',
      rows: [
        sample({
          thread_id: 'rows-sample-stopped',
          project: { id: 'prj_billing', name: 'billing-svc' },
          thread_name: 'Postgres 17 migration',
          subject: 'The staging password expired: can you rotate it?',
          latest_preview: 'Asked: The staging password expired: can you rotate it?',
          author: { kind: 'agent', host: 'codex', session: 'ses_b', name: null },
          section: 'stopped',
          questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: null },
          last_at: ago(38),
        }),
      ],
    },
    {
      id: 'waiting',
      label: 'Waiting on you',
      rows: [
        sample({
          thread_id: 'rows-sample-named',
          project: { id: 'prj_store', name: 'storefront' },
          thread_name: 'Checkout redesign',
          subject: 'Which cart layout should ship first?',
          latest_preview: 'Asked: Which cart layout should ship first?',
          participants: [
            { host: 'claude-code', session: 'ses_a' },
            { host: 'codex', session: 'ses_c' },
          ],
          section: 'waiting',
          unread: true,
          questions: { open: 2, picked: 0, stopped: false, holds_up: [], prompt: null },
          last_at: ago(4),
        }),
      ],
    },
    {
      // A thread with nothing left to do, so Show → Status mark has a "done" to draw.
      id: 'quiet',
      label: 'Quiet',
      rows: [
        sample({
          thread_id: 'rows-sample-plain',
          subject: 'Tests pass on main after the retry fix',
          // The grey line is the latest message (approval "inbox-row-latest-preview"): here the person's reply.
          latest_preview: 'You: Merge it once CI is green.',
          author: { kind: 'agent', host: 'pi', session: 'ses_p', name: null },
          section: 'quiet',
          waiting_on_person: false,
          last_at: ago(52),
        }),
      ],
    },
  ];
}

/** One picture: a list column with the sample rows in `shape`, the look applied. Not interactive, not announced. */
function PreviewList({ look, shape, className }: { look: ListLook; shape: 'narrow' | 'wide' | 'phone'; className: string }) {
  const [groups] = useState(sampleGroups);
  return (
    // The sample projects have no pictures: their marks are letters (`pictures` off asks the Inbox for none).
    <RowMarksScope look={look} pictures={false}>
      <section className={`ib-listcol ib-rws-list ${className}${look.hideProject ? ' ib-noproj' : ''}${listLookClasses(look)}`} aria-hidden="true">
        {/* The rows alone, no bands: nothing here changes a band, and the page keeps both pictures in one screen. */}
        <div className="ib-lbody">
          <div className="ib-group">
            {groups.flatMap((group) =>
              group.rows.map((row) => (
                <ListRow
                  key={row.thread_id}
                  row={row}
                  project={row.project.name}
                  away={false}
                  drawn={group.id}
                  shape={shape}
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
                />
              )),
            )}
          </div>
        </div>
      </section>
    </RowMarksScope>
  );
}

/** The wide picture: drawn at a wide list's width, zoomed down to the page's when that is narrower. */
function WidePreview({ look }: { look: ListLook }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(WIDE_PREVIEW_PX);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || WIDE_PREVIEW_PX);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  const zoom = Math.min(1, width / WIDE_PREVIEW_PX);
  return (
    <div ref={frame} className="ib-rws-frame ib-rws-wide" inert data-rows-preview="wide">
      <div style={{ width: zoom < 1 ? WIDE_PREVIEW_PX : '100%', zoom: zoom < 1 ? zoom : undefined }}>
        <PreviewList look={look} shape="wide" className="" />
      </div>
    </div>
  );
}

/** A row's two- or three-way choice, as Settings → General's Theme and Text size. */
function Seg<T extends string>({ name, labelledBy, value, choices, onChange }: { name: string; labelledBy: string; value: T | null; choices: readonly { id: T; label: string }[]; onChange: (next: T) => void }) {
  return (
    <span className="ib-seg" role="radiogroup" aria-labelledby={labelledBy}>
      {choices.map((choice) => (
        <label key={choice.id} className="ib-seg-o" data-on={value === choice.id ? '' : undefined}>
          <input type="radio" name={name} value={choice.id} checked={value === choice.id} onChange={() => onChange(choice.id)} />
          {choice.label}
        </label>
      ))}
    </span>
  );
}

/** A Look row: its title (naming the choice for a screen reader) and its segmented choice. */
function LookRow<T extends string>({ id, label, desc, value, choices, onChange }: { id: string; label: string; desc?: string; value: T | null; choices: readonly { id: T; label: string }[]; onChange: (next: T) => void }) {
  return (
    <div className="ib-prow" data-rows-control={id}>
      <span className="ib-txt">
        <span className="ib-l" id={`ib-rows-${id}`}>
          {label}
        </span>
        {desc && <span className="ib-desc">{desc}</span>}
      </span>
      <span className="ib-ctl">
        <Seg name={`ib-rows-${id}`} labelledBy={`ib-rows-${id}`} value={value} choices={choices} onChange={onChange} />
      </span>
    </div>
  );
}

/**
 * The Show card's switches: on is shown. Each hides with its `ListLook` key. The page's words follow the owner's rule
 * (2026-11-07: "only necessary labels or words for things that are not intuitive"): a description says only what the
 * pictures cannot show (a machine, where a picture comes from, a side effect).
 */
const SHOW: readonly { key: ListLookKey; label: string; desc?: string }[] = [
  { key: 'hideAgents', label: 'Agent icons' },
  { key: 'hideProject', label: 'Project', desc: 'With its machine' },
];

/** The notes-list look's switches (all off by default): on is shown, as each one's own `ListLook` key. */
// Words as few as the owner asked (2026-11-07: "only necessary labels or words for things that are not intuitive"):
// the pictures show Dividers and Bold names, so only Status mark says what it replaces.
const NOTES_LOOK: readonly { key: 'dividers' | 'statusMark' | 'boldNames'; label: string; desc?: string }[] = [
  { key: 'dividers', label: 'Dividers' },
  { key: 'statusMark', label: 'Status mark', desc: 'Instead of counts' },
  { key: 'boldNames', label: 'Bold names' },
];

/** A project's picture instead of its letters. Turning one on turns project marks on (listLook.ts `lookWithChange`). */
const PICTURES: readonly { key: 'repoLogo' | 'githubPictures'; label: string; desc: string }[] = [
  { key: 'repoLogo', label: 'Logo from the repo', desc: 'Stays on this computer' },
  { key: 'githubPictures', label: 'GitHub pictures', desc: "The owner's picture. Asks GitHub once a week." },
];

/** A Show switch that is on while its option is (the notes-list look's, the picture switches), with its words, if any, for a screen reader. */
function OnSwitch({ id, label, desc, on, onToggle }: { id: ListLookKey; label: string; desc?: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="ib-prow" data-rows-control={id}>
      <span className="ib-txt">
        <span className="ib-l" id={`ib-rows-${id}`}>
          {label}
        </span>
        {desc && (
          <span className="ib-desc" id={`ib-rows-${id}-desc`}>
            {desc}
          </span>
        )}
      </span>
      <span className="ib-ctl">
        <button type="button" role="switch" className="ib-sw" aria-checked={on} aria-labelledby={`ib-rows-${id}`} aria-describedby={desc ? `ib-rows-${id}-desc` : undefined} onClick={onToggle} />
      </span>
    </div>
  );
}

export type RowsPreset = 'minimal' | 'balanced' | 'detailed';

/**
 * The presets: starting points, each a whole look. Balanced is the defaults (smaller thread names on, every other
 * option off), so choosing it is also how to reset. Detailed keeps the larger unread names it had before smaller
 * names became the default. A look that matches none reads "Custom": a look saved as Detailed before Detailed turned
 * letter marks on (approval "inbox-letter-marks") now reads Custom until Detailed is picked again.
 */
// Letter marks (approval "inbox-letter-marks"): Minimal and Balanced keep them off (Balanced is the defaults); Detailed
// turns them on, both kinds as Avatar (no style option on), with the repo's logo on and GitHub pictures off.
export const ROWS_PRESETS: readonly { id: RowsPreset; label: string; look: ListLook }[] = [
  // Minimal (approval "inbox-rows-dialog", round 7b): the two-line title-first row, no preview, no dot, clock times.
  { id: 'minimal', label: 'Minimal', look: { ...LIST_LOOK_OFF, titleFirst: true, hidePreview: true, smallNames: true } },
  { id: 'balanced', label: 'Balanced', look: LIST_LOOK_DEFAULT },
  {
    id: 'detailed',
    label: 'Detailed',
    look: {
      ...LIST_LOOK_OFF,
      roomy: true,
      // No subject pill beside the avatars (pending owner answer q-70c1a472). To undo: `highlight: true`.
      previewTwo: true,
      marksThreads: true,
      marksProjects: true,
      // The repo's logo on project marks (pending owner answer q-737e5fd4): a local file, nothing asked of GitHub.
      repoLogo: true,
    },
  },
];

export function rowsPreset(look: ListLook): RowsPreset | null {
  return ROWS_PRESETS.find((preset) => LIST_LOOK_KEYS.every((key) => preset.look[key] === look[key]))?.id ?? null;
}

export function RowsSection({ phone, onGeneral }: { phone: boolean; onGeneral?: () => void }) {
  // A choice that turns one option on turns its rival off (Compact and Roomy; no preview and two lines), in one write.
  const [look, set] = useListLook();
  const marks = lookMarks(look);
  const preset = rowsPreset(look);
  // Buttons, not radios: a radio group's arrow keys choose as they move, so one stray key would wipe a Custom look.
  // Tab reaches each preset, and only Enter, Space or a click applies one; the pressed one is the look's.
  const presets = (
    <div className="ib-rws-presets" data-rows-preset={preset ?? 'custom'}>
      <span className="ib-l" id="ib-rows-preset">
        Start from
      </span>
      <span className="ib-seg" role="group" aria-labelledby="ib-rows-preset" aria-describedby={preset ? undefined : 'ib-rows-custom'}>
        {ROWS_PRESETS.map((choice) => (
          <button key={choice.id} type="button" className="ib-seg-o" aria-pressed={preset === choice.id} data-on={preset === choice.id ? '' : undefined} data-preset={choice.id} onClick={() => set(choice.look)}>
            {choice.label}
          </button>
        ))}
      </span>
      {/* Not a choice: says the look was changed from every preset. Balanced puts the defaults back. */}
      {!preset && (
        <span className="ib-rws-custom" id="ib-rows-custom">
          Custom
        </span>
      )}
    </div>
  );
  const controls = (
    <div className="ib-rws-ctl">
      <section className="ib-sgroup ib-sgroup-first" aria-labelledby="ib-g-rows-look">
        <h2 id="ib-g-rows-look">Look</h2>
        <div className="ib-card">
          <LookRow
            id="density"
            label="Density"
            value={look.compact ? 'compact' : look.roomy ? 'roomy' : 'comfortable'}
            choices={[
              { id: 'compact', label: 'Compact' },
              { id: 'comfortable', label: 'Comfortable' },
              { id: 'roomy', label: 'Roomy' },
            ]}
            onChange={(next) => set({ compact: next === 'compact', roomy: next === 'roomy' })}
          />
          <LookRow
            id="first"
            label="First line"
            value={look.titleFirst ? 'name' : 'project'}
            choices={[
              { id: 'project', label: 'Project' },
              { id: 'name', label: 'Thread name' },
            ]}
            onChange={(next) => set({ titleFirst: next === 'name' })}
          />
          <LookRow
            id="names"
            label="Thread names"
            value={look.highlight ? 'pill' : 'plain'}
            choices={[
              { id: 'plain', label: 'Plain' },
              { id: 'pill', label: 'Highlighted' },
            ]}
            onChange={(next) => set({ highlight: next === 'pill' })}
          />
          {/* Where a letter mark lives. Nothing is picked while marks are off; picking one turns thread marks on, so
              the choice never does nothing. */}
          <LookRow<MarkStyle>
            id="markstyle"
            label="Mark style"
            desc={marks.what === 'off' ? 'Turns letter marks on' : undefined}
            value={marks.what === 'off' ? null : marks.style}
            choices={[
              { id: 'inline', label: 'Inline' },
              { id: 'avatar', label: 'Avatar' },
              { id: 'dot', label: 'Dot' },
            ]}
            onChange={(style) => set(markStyleLook(style, look))}
          />
          <LookRow
            id="unread"
            label="Unread"
            value={look.unreadDot ? 'dot' : look.smallNames ? 'bold' : 'larger'}
            choices={[
              { id: 'larger', label: 'Larger' },
              { id: 'bold', label: 'Bold' },
              { id: 'dot', label: 'Dot' },
            ]}
            onChange={(next) => set({ smallNames: next !== 'larger', unreadDot: next === 'dot' })}
          />
          <LookRow
            id="preview"
            label="Preview"
            value={look.hidePreview ? 'none' : look.previewTwo ? 'two' : 'one'}
            choices={[
              { id: 'none', label: 'None' },
              { id: 'one', label: '1 line' },
              { id: 'two', label: '2 lines' },
            ]}
            onChange={(next) => set({ hidePreview: next === 'none', previewTwo: next === 'two' })}
          />
          <LookRow
            id="time"
            label="Time"
            value={look.relativeTime ? 'relative' : 'clock'}
            choices={[
              { id: 'clock', label: 'Clock' },
              { id: 'relative', label: 'Relative' },
            ]}
            onChange={(next) => set({ relativeTime: next === 'relative' })}
          />
          {/* Where the time sits on three-line and phone rows; a full-width row keeps its columns. */}
          <LookRow
            id="timeplace"
            label="Time position"
            value={look.timeBelow ? 'below' : 'top'}
            choices={[
              { id: 'top', label: 'Top right' },
              { id: 'below', label: 'Under the preview' },
            ]}
            onChange={(next) => set({ timeBelow: next === 'below' })}
          />
        </div>
      </section>
      <section className="ib-sgroup" aria-labelledby="ib-g-rows-show">
        <h2 id="ib-g-rows-show">Show</h2>
        <div className="ib-card">
          {SHOW.map((item) => (
            <div className="ib-prow" key={item.key} data-rows-control={item.key}>
              <span className="ib-txt">
                <span className="ib-l" id={`ib-rows-${item.key}`}>
                  {item.label}
                </span>
                {item.desc && (
                  <span className="ib-desc" id={`ib-rows-${item.key}-desc`}>
                    {item.desc}
                  </span>
                )}
              </span>
              <span className="ib-ctl">
                <button
                  type="button"
                  role="switch"
                  className="ib-sw"
                  aria-checked={!look[item.key]}
                  aria-labelledby={`ib-rows-${item.key}`}
                  aria-describedby={item.desc ? `ib-rows-${item.key}-desc` : undefined}
                  onClick={() => set({ [item.key]: !look[item.key] })}
                />
              </span>
            </div>
          ))}
          {NOTES_LOOK.map((item) => (
            <OnSwitch key={item.key} id={item.key} label={item.label} desc={item.desc} on={look[item.key]} onToggle={() => set({ [item.key]: !look[item.key] })} />
          ))}
          <LookRow<MarksWhat>
            id="marks"
            label="Letter marks"
            value={marks.what}
            choices={[
              { id: 'off', label: 'Off' },
              { id: 'threads', label: 'Threads' },
              { id: 'projects', label: 'Projects' },
              { id: 'both', label: 'Both' },
            ]}
            onChange={(what) => set(marksWhatLook(what))}
          />
          {PICTURES.map((item) => (
            <OnSwitch key={item.key} id={item.key} label={item.label} desc={item.desc} on={look[item.key]} onToggle={() => set({ [item.key]: !look[item.key] })} />
          ))}
        </div>
      </section>
    </div>
  );
  const note = (
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
  );
  return (
    <div className="ib-rws" data-settings-rows="">
      {/* Settings draws no lede of its own for Rows: this one has the presets beside it. */}
      <div className="ib-rws-head">
        <p className="ib-lede">Changes apply everywhere you use the Inbox.</p>
        {presets}
      </div>
      <div className="ib-rws-top">
        <figure className="ib-rws-fig ib-rws-fig-narrow">
          <figcaption>{phone ? 'On this phone' : 'With a thread open'}</figcaption>
          <div className="ib-rws-frame ib-rws-narrow" inert data-rows-preview={phone ? 'phone' : 'narrow'}>
            <PreviewList look={look} shape={phone ? 'phone' : 'narrow'} className={phone ? '' : 'ib-narrow'} />
          </div>
        </figure>
        {controls}
      </div>
      {!phone && (
        <figure className="ib-rws-fig ib-rws-fig-wide">
          <figcaption>Full width</figcaption>
          <WidePreview look={look} />
        </figure>
      )}
      {note}
    </div>
  );
}

/** The phone list's value beside Rows: the preset's name, or "Custom". */
export function rowsSummary(look: ListLook): string {
  const preset = rowsPreset(look);
  return preset ? ROWS_PRESETS.find((p) => p.id === preset)!.label : 'Custom';
}
