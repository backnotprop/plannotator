import { useEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { INBOX_NO_INITIATIVE, type InboxInitiative } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from '../api';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';

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
  projects: readonly ProjectFolder[];
  names: ReadonlyMap<string, string>;
  project: string | null;
  onProject: (project: string | null) => void;
  initiatives: readonly InboxInitiative[];
  counts: ReadonlyMap<string, number>;
  initiative: string | null;
  onInitiative: (initiative: string | null) => void;
  onManage: (start: 'new' | 'edit') => void;
  phone: boolean;
  tokens: boolean;
}

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

export function initiativeLabel(initiatives: readonly InboxInitiative[], initiative: string | null): string | null {
  if (initiative === null) return null;
  if (initiative === INBOX_NO_INITIATIVE) return 'No initiative';
  return initiatives.find((i) => i.id === initiative)?.name ?? 'Initiative';
}

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
