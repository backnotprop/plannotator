import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { INBOX_INITIATIVE_NAME_MAX, INBOX_NO_INITIATIVE, type InboxInitiative } from '@plannotator/core/inbox-types';
import { inboxApi, type ProjectFolder } from '../api';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { Modal } from '../components/Updates';

/** The list-filter glyph (lucide's list-filter, drawn with the window's icon stroke; the icon set has none). */
function FilterGlyph({ size }: { size: number }) {
  return (
    <svg className="ib-ic" viewBox="0 0 24 24" style={{ width: size, height: size }} aria-hidden="true" focusable="false">
      <path d="M3 6h18M7 12h10M10 18h4" />
    </svg>
  );
}

/** The menus are drawn inside the window's root, so its styles (and theme) reach them. */
function usePortal(anchor: React.RefObject<HTMLElement | null>) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), [anchor]);
  return portal;
}

export interface BoardFilterProps {
  /** The projects offered (`boardProjects`); the Project group shows only when there are two or one is picked. */
  projects: readonly ProjectFolder[];
  names: ReadonlyMap<string, string>;
  project: string | null;
  onProject: (project: string | null) => void;
  /** The live initiatives, in the order they were made. */
  initiatives: readonly InboxInitiative[];
  /** Cards per initiative id and `none` (initiativeCounts), on the lanes of the picked project. */
  counts: ReadonlyMap<string, number>;
  /** An `ini_` id, `none`, or null for every card. */
  initiative: string | null;
  onInitiative: (initiative: string | null) => void;
  /** New initiative… and Edit initiatives…: the Initiatives dialog. */
  onManage: (start: 'new' | 'edit') => void;
  phone: boolean;
  /** The picks as tokens beside the button (a wide header); false: BoardFilterTokens draws them on their own row. */
  tokens: boolean;
}

/**
 * The Board's one filter (approval "board-initiatives", take C): an icon at
 * the header's right; its menu holds Initiative (All initiatives, each one
 * with its count, No initiative with its count, then New initiative… and
 * Edit initiatives…) and, once the cards span two projects, Project. The
 * picks show as tokens left of it ("# Shape ×"). Base UI carries the keys
 * (arrows, type-ahead, Escape). No shortcut of its own.
 */
export function BoardFilter(props: BoardFilterProps) {
  const { initiative, project, phone } = props;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const portal = usePortal(trigger);
  const initiativeName = initiativeLabel(props.initiatives, initiative);
  const projectName = project ? (props.names.get(project) ?? 'Project') : null;
  const set = initiative !== null || project !== null;
  const showProjects = props.projects.length > 1 || project !== null;
  const picked = [initiativeName, projectName].filter(Boolean).join(', ');
  return (
    <span className="ib-bflt" data-set={set ? '' : undefined} data-board-filter="">
      {props.tokens && <BoardFilterTokens {...props} focusAfterClear={() => trigger.current} />}
      <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
        <Tip content="Filter">
          <Menu.Trigger ref={trigger} className="ib-bflt-btn" aria-label={set ? `Filter: ${picked}` : 'Filter'} data-board-filter-button="">
            <FilterGlyph size={phone ? 20 : 16} />
          </Menu.Trigger>
        </Tip>
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm ib-bflt-menu" aria-label="Filter" data-board-filter-menu="">
              <Menu.Group>
                <Menu.GroupLabel className="ib-pm-glabel">Initiative</Menu.GroupLabel>
                <Menu.RadioGroup value={initiative ?? ''} onValueChange={(next: string) => next !== (initiative ?? '') && props.onInitiative(next || null)}>
                  <FilterItem value="" label="All initiatives" icon="layers" on={initiative === null} data={{ 'data-board-initiative-option': '' }} />
                  {props.initiatives.map((i) => (
                    <FilterItem key={i.id} value={i.id} label={i.name} icon="hash" count={props.counts.get(i.id) ?? 0} on={initiative === i.id} data={{ 'data-board-initiative-option': i.id }} />
                  ))}
                  <FilterItem
                    value={INBOX_NO_INITIATIVE}
                    label="No initiative"
                    icon="minus"
                    count={props.counts.get(INBOX_NO_INITIATIVE) ?? 0}
                    on={initiative === INBOX_NO_INITIATIVE}
                    data={{ 'data-board-initiative-option': INBOX_NO_INITIATIVE }}
                  />
                </Menu.RadioGroup>
                <Menu.Item className="ib-pmi ib-bflt-act" label="New initiative…" onClick={() => props.onManage('new')} data-board-initiative-new="">
                  <span className="ib-bflt-ico" aria-hidden="true">
                    <Icon name="plus" size={14} />
                  </span>
                  <span className="ib-pmi-l">New initiative…</span>
                </Menu.Item>
                {props.initiatives.length > 0 && (
                  <Menu.Item className="ib-pmi ib-bflt-act" label="Edit initiatives…" onClick={() => props.onManage('edit')} data-board-initiative-edit="">
                    <span className="ib-bflt-ico" aria-hidden="true">
                      <Icon name="pen" size={14} />
                    </span>
                    <span className="ib-pmi-l">Edit initiatives…</span>
                  </Menu.Item>
                )}
              </Menu.Group>
              {showProjects && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Group>
                    <Menu.GroupLabel className="ib-pm-glabel">Project</Menu.GroupLabel>
                    <Menu.RadioGroup value={project ?? ''} onValueChange={(next: string) => next !== (project ?? '') && props.onProject(next || null)}>
                      <FilterItem value="" label="All projects" icon="layers" on={project === null} data={{ 'data-board-project-option': '' }} />
                      {props.projects.map((p) => {
                        const shown = props.names.get(p.id) ?? p.name;
                        return <FilterItem key={p.id} value={p.id} label={shown} icon="folder" on={project === p.id} data={{ 'data-board-project-option': p.id }} />;
                      })}
                    </Menu.RadioGroup>
                  </Menu.Group>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}

/** One row of the filter: its icon, its name, its count (initiatives), the check when picked. */
function FilterItem({ value, label, icon, count, on, data }: { value: string; label: string; icon: 'layers' | 'hash' | 'minus' | 'folder'; count?: number; on: boolean; data: Record<string, string> }) {
  return (
    <Menu.RadioItem value={value} closeOnClick className="ib-pmi" label={label} {...data}>
      <span className="ib-bflt-ico" aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
      <Tip content={label} cut side="right">
        <span className="ib-pmi-l" dir="auto">
          {label}
        </span>
      </Tip>
      {count !== undefined && <span className="ib-bflt-n">{count}</span>}
      {on ? <Icon name="check" size={15} className="ib-pmi-check ib-bflt-check" /> : <span className="ib-bflt-slot" />}
    </Menu.RadioItem>
  );
}

/** The picked initiative's name: "No initiative" for none, null when nothing is picked (or it is not loaded yet). */
export function initiativeLabel(initiatives: readonly InboxInitiative[], initiative: string | null): string | null {
  if (initiative === null) return null;
  if (initiative === INBOX_NO_INITIATIVE) return 'No initiative';
  return initiatives.find((i) => i.id === initiative)?.name ?? 'Initiative';
}

/**
 * The picks as tokens: "# Shape ×", "folder plannotator ×". Beside the
 * filter's icon on a wide header; on their own row under it on a phone or a
 * narrow page, so the header never cuts them.
 */
export function BoardFilterTokens(
  props: Pick<BoardFilterProps, 'initiatives' | 'initiative' | 'onInitiative' | 'names' | 'project' | 'onProject'> & { focusAfterClear?: () => HTMLElement | null },
) {
  const initiativeName = initiativeLabel(props.initiatives, props.initiative);
  const projectName = props.project ? (props.names.get(props.project) ?? 'Project') : null;
  if (!initiativeName && !projectName) return null;
  const refocus = () =>
    requestAnimationFrame(() => (props.focusAfterClear?.() ?? document.querySelector<HTMLElement>('.ib-bpage [data-board-filter-button]'))?.focus());
  return (
    <>
      {initiativeName && (
        <Token
          kind="initiative"
          icon={props.initiative === INBOX_NO_INITIATIVE ? 'minus' : 'hash'}
          label={initiativeName}
          clearLabel="Clear the initiative filter"
          onClear={() => {
            props.onInitiative(null);
            refocus();
          }}
        />
      )}
      {projectName && (
        <Token
          kind="project"
          icon="folder"
          label={projectName}
          clearLabel="Clear the project filter"
          onClear={() => {
            props.onProject(null);
            refocus();
          }}
        />
      )}
    </>
  );
}

function Token({ kind, icon, label, clearLabel, onClear }: { kind: 'initiative' | 'project'; icon: 'hash' | 'minus' | 'folder'; label: string; clearLabel: string; onClear: () => void }) {
  return (
    <span className="ib-bflt-tok" data-board-filter-token={kind}>
      <Icon name={icon} size={13} />
      <span className="ib-bflt-tok-l" dir="auto">
        {label}
      </span>
      <button type="button" className="ib-bflt-tok-x" aria-label={clearLabel} onClick={onClear} data-board-filter-clear={kind}>
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

/**
 * A card's initiative as a menu (the opened card): "# Shape", or "No
 * initiative"; the menu's rows are CardInitiativeItems. Shown once an
 * initiative exists (or the card is in one).
 */
export function CardInitiativeMenu({ initiatives, value, onPick }: { initiatives: readonly InboxInitiative[]; value: string | null; onPick: (initiative: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const portal = usePortal(trigger);
  const name = value ? (initiatives.find((i) => i.id === value)?.name ?? null) : null;
  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
      <Menu.Trigger ref={trigger} className="ib-crdp-ini" data-card-initiative={value ?? INBOX_NO_INITIATIVE} aria-label={`Initiative: ${name ?? 'none'}. Change`}>
        <Icon name={name ? 'hash' : 'minus'} size={14} />
        <span dir="auto">{name ?? 'No initiative'}</span>
        <Icon name="chevD" size={13} />
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="ib-pm ib-bflt-menu" aria-label="Initiative" data-card-initiative-menu="">
            <CardInitiativeItems initiatives={initiatives} value={value} onPick={onPick} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The rows that put a card in an initiative: each live one, then No initiative; the card's own checked. */
export function CardInitiativeItems({ initiatives, value, onPick }: { initiatives: readonly InboxInitiative[]; value: string | null; onPick: (initiative: string | null) => void }) {
  const current = value ?? INBOX_NO_INITIATIVE;
  return (
    <Menu.RadioGroup value={current} onValueChange={(next: string) => next !== current && onPick(next === INBOX_NO_INITIATIVE ? null : next)} aria-label="Initiative">
      {initiatives.map((i) => (
        <Menu.RadioItem key={i.id} value={i.id} closeOnClick className="ib-pmi" label={i.name} data-card-initiative-option={i.id}>
          <span className="ib-bflt-ico" aria-hidden="true">
            <Icon name="hash" size={14} />
          </span>
          <span className="ib-pmi-l" dir="auto">
            {i.name}
          </span>
          {current === i.id && <Icon name="check" size={15} className="ib-pmi-check" />}
        </Menu.RadioItem>
      ))}
      <Menu.Separator className="ib-pm-sep" />
      <Menu.RadioItem value={INBOX_NO_INITIATIVE} closeOnClick className="ib-pmi" label="No initiative" data-card-initiative-option={INBOX_NO_INITIATIVE}>
        <span className="ib-bflt-ico" aria-hidden="true">
          <Icon name="minus" size={14} />
        </span>
        <span className="ib-pmi-l">No initiative</span>
        {current === INBOX_NO_INITIATIVE && <Icon name="check" size={15} className="ib-pmi-check" />}
      </Menu.RadioItem>
    </Menu.RadioGroup>
  );
}

/**
 * Initiatives (the filter's New initiative… and Edit initiatives…): every
 * live one as a name to edit in place (Enter or leaving the field renames it)
 * with Delete, which asks once ("Its 4 cards go to No initiative"); a field to
 * add one. Every change is its own write; the Board reads the cards again.
 */
export function InitiativesDialog({
  initiatives,
  cardCounts,
  start,
  phone,
  onClose,
  onChanged,
}: {
  initiatives: readonly InboxInitiative[];
  /** Cards in each initiative, every column (what a delete leaves in none). */
  cardCounts: ReadonlyMap<string, number>;
  start: 'new' | 'edit';
  phone: boolean;
  onClose: () => void;
  /** An initiative was made, renamed or deleted: read the cards again. `made` names a new one. */
  onChanged: (made?: InboxInitiative) => void;
}) {
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const newField = useRef<HTMLInputElement>(null);
  // The dialog first focuses its primary button: New initiative… lands in the name field instead.
  useEffect(() => {
    if (start !== 'new') return;
    const frame = requestAnimationFrame(() => newField.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [start]);
  const run = async (work: () => Promise<InboxInitiative>): Promise<InboxInitiative | null> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not save. Try again.');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const name = adding.replace(/\s+/g, ' ').trim();
    if (!name) {
      newField.current?.focus();
      return;
    }
    const made = await run(async () => (await inboxApi.createInitiative(name)).initiative);
    if (!made) return;
    setAdding('');
    onChanged(made);
    newField.current?.focus();
  };
  let body: ReactNode = null;
  if (initiatives.length > 0) {
    body = (
      <ul className="ib-inid-list" aria-label="Initiatives">
        {initiatives.map((i) =>
          asking === i.id ? (
            <li key={i.id} className="ib-inid-ask" data-initiative-delete-ask={i.id}>
              <span className="ib-inid-askt">
                Delete <b dir="auto">{i.name}</b>?{' '}
                {(cardCounts.get(i.id) ?? 0) > 0 && `Its ${cardCounts.get(i.id) === 1 ? 'card goes' : `${cardCounts.get(i.id)} cards go`} to No initiative.`}
              </span>
              <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="ib-btn ib-sm ib-danger"
                data-initiative-delete-yes=""
                disabled={busy}
                onClick={async () => {
                  const gone = await run(async () => (await inboxApi.changeInitiative(i.id, { op: 'delete' })).initiative);
                  if (!gone) return;
                  setAsking(null);
                  onChanged();
                }}
              >
                Delete
              </button>
            </li>
          ) : (
            <InitiativeRow
              key={i.id}
              initiative={i}
              busy={busy}
              onRename={async (name) => {
                const renamed = await run(async () => (await inboxApi.changeInitiative(i.id, { op: 'rename', name })).initiative);
                if (renamed) onChanged();
                return renamed !== null;
              }}
              onDelete={() => setAsking(i.id)}
            />
          ),
        )}
      </ul>
    );
  }
  return (
    <Modal label="Initiatives" testId="initiatives" onClose={onClose} ownKeys className={`ib-inid${phone ? ' ib-inid-phone' : ''}`}>
      <div className="ib-dlg-in">
        <div className="ib-dlg-head">
          <h2>Initiatives</h2>
          <button type="button" className="ib-ncd-x" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {body}
        <form
          className="ib-inid-add"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <span className="ib-bflt-ico" aria-hidden="true">
            <Icon name="plus" size={14} />
          </span>
          <input
            ref={newField}
            type="text"
            className="ib-inid-in"
            placeholder="New initiative"
            aria-label="New initiative"
            maxLength={INBOX_INITIATIVE_NAME_MAX}
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            data-initiative-new-name=""
          />
          <button type="submit" className="ib-btn ib-sm" disabled={busy || !adding.trim()} data-initiative-add="">
            Add
          </button>
        </form>
        {error && (
          <p className="ib-error ib-inid-err" role="alert" data-initiative-error="">
            {error}
          </p>
        )}
        <div className="ib-acts-row">
          <button type="button" className="ib-btn ib-pri" onClick={onClose} data-initiatives-done="">
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One initiative in the dialog: its name, edited in place, and Delete. */
function InitiativeRow({ initiative, busy, onRename, onDelete }: { initiative: InboxInitiative; busy: boolean; onRename: (name: string) => Promise<boolean>; onDelete: () => void }) {
  const [draft, setDraft] = useState(initiative.name);
  useEffect(() => setDraft(initiative.name), [initiative.name]);
  const commit = async () => {
    const name = draft.replace(/\s+/g, ' ').trim();
    if (!name || name === initiative.name) {
      setDraft(initiative.name);
      return;
    }
    if (!(await onRename(name))) setDraft(initiative.name);
  };
  return (
    <li className="ib-inid-row" data-initiative-row={initiative.id}>
      <span className="ib-bflt-ico" aria-hidden="true">
        <Icon name="hash" size={14} />
      </span>
      <input
        type="text"
        className="ib-inid-in"
        aria-label={`Name of ${initiative.name}`}
        maxLength={INBOX_INITIATIVE_NAME_MAX}
        value={draft}
        dir="auto"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
          }
        }}
        data-initiative-name=""
      />
      <Tip content="Delete">
        <button type="button" className="ib-iconbtn ib-inid-del" aria-label={`Delete ${initiative.name}`} disabled={busy} onClick={onDelete} data-initiative-delete="">
          <Icon name="trash" size={15} />
        </button>
      </Tip>
    </li>
  );
}
