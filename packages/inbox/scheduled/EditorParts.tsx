/**
 * The editor's prompt foot and its folder and files: "Runs as" (New message's agent, model and effort), Repo or folder (New
 * message's folder menu) and Files (paths on this computer that each run's divider carries).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { usePhone } from '../phone';
import { INBOX_HOST_NAMES, type InboxComposeLaunch } from '@plannotator/core/inbox-types';
import type { InboxScheduledFolder } from '@plannotator/core/inbox-scheduled-types';
import { inboxApi } from '../api';
import { FolderMenu } from '../compose/FolderMenu';
import { LaunchChoiceButton, LaunchChoiceMenu } from '../compose/LaunchChoiceMenu';
import { SCRATCH_PICK } from '../compose/model';
import { tildePath } from '../format';
import { HostMark, Icon } from '../icons';

export interface LaunchBlock {
  home: string;
  launch: InboxComposeLaunch | null;
}

/** New message's launch block: the agents this computer can start, their models, and its projects. */
export function useLaunchBlock(): LaunchBlock | null {
  const [block, setBlock] = useState<LaunchBlock | null>(null);
  useEffect(() => {
    let live = true;
    inboxApi.composeSessions().then(
      (model) => live && setBlock({ home: model.home, launch: model.launch ?? null }),
      () => live && setBlock({ home: '', launch: null }),
    );
    return () => {
      live = false;
    };
  }, []);
  return block;
}

function usePortal() {
  const anchor = useRef<HTMLButtonElement>(null);
  // On a phone, main's bottom sheet (inbox.css `.ib-pm-pos[data-phone]`): it fits the screen and scrolls.
  const sheet = usePhone();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  return { anchor, portal, sheet };
}

export function RunsAs({ block, agent, model, effort, phone, onChange }: { block: LaunchBlock | null; agent: string; model?: string; effort?: string; phone: boolean; onChange: (next: { agent: string; model?: string; effort?: string }) => void }) {
  const { anchor, portal, sheet } = usePortal();
  const [choiceOpen, setChoiceOpen] = useState(false);
  const agents = block?.launch?.agents ?? [];
  const current = agents.find((a) => a.agent === agent);
  const name = current?.name ?? INBOX_HOST_NAMES[agent] ?? agent;
  const choices = current?.choices;
  const offered = !!choices && (choices.models.length > 0 || choices.efforts.length > 0);
  const choice = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  return (
    <div className="st-foot" data-runs-as="">
      <span className="st-lbl">Runs as</span>
      <Menu.Root modal={false}>
        <Menu.Trigger ref={anchor} className="st-gh" aria-label={`Agent: ${name}. Change`} data-runs-as-agent={agent}>
          <HostMark host={agent} />
          {name}
          <Icon name="chevD" size={12} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {sheet && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={sheet ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label="Agent">
              <Menu.RadioGroup value={agent} onValueChange={(next: string) => next !== agent && onChange({ agent: next })}>
                {agents.map((a) => (
                  <Menu.RadioItem key={a.agent} value={a.agent} closeOnClick className="ib-pmi" label={a.name}>
                    <HostMark host={a.agent} />
                    <span className="ib-pmi-l">{a.name}</span>
                    {a.agent === agent && <Icon name="check" size={15} className="ib-pmi-check" />}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {offered && (
        <>
          <span className="st-sep" aria-hidden="true" />
          <LaunchChoiceButton choice={choice} choices={choices!} open={choiceOpen} className="st-gh" onToggle={() => setChoiceOpen((was) => !was)} />
          {choiceOpen && <LaunchChoiceMenu choice={choice} choices={choices!} phone={phone} onClose={() => setChoiceOpen(false)} onChoice={(next) => onChange({ agent, ...next })} />}
        </>
      )}
    </div>
  );
}

export function FolderPick({ block, folder, shown, agentName, phone, onChange }: { block: LaunchBlock | null; folder: InboxScheduledFolder; shown: string | null; agentName: string; phone: boolean; onChange: (next: InboxScheduledFolder) => void }) {
  const [open, setOpen] = useState(false);
  const launch = block?.launch ?? null;
  const home = block?.home ?? null;
  const project = 'project_id' in folder ? launch?.projects.find((p) => p.id === folder.project_id) : undefined;
  const words = 'scratch' in folder ? 'New scratch folder' : (shown ?? (project ? tildePath(project.root, home) : 'path' in folder ? tildePath(folder.path, home) : 'Pick a folder'));
  return (
    <div className="st-folder">
      <button type="button" className="st-chip" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((was) => !was)} disabled={!launch} data-scheduled-folder="">
        <Icon name="folder" />
        <span>{words}</span>
        <Icon name="chevD" size={12} />
      </button>
      {open && launch && (
        <FolderMenu
          projects={launch.projects}
          selected={'scratch' in folder ? SCRATCH_PICK : 'project_id' in folder ? folder.project_id : null}
          home={home}
          phone={phone}
          onPick={(picked) => {
            setOpen(false);
            onChange({ project_id: picked.id });
          }}
          onFolder={(path) => {
            setOpen(false);
            onChange({ path });
          }}
          folderPicked={'path' in folder ? { folder: tildePath(folder.path, home), machine: null } : null}
          scratch={launch.scratch ? { folder: tildePath(launch.scratch.root, home), root: tildePath(launch.scratch.root, home), trusted: true, agentName } : null}
          onScratch={() => {
            setOpen(false);
            onChange({ scratch: true });
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export function FilesRow({ files, onChange }: { files: readonly string[]; onChange: (next: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const add = () => {
    const next = path.trim();
    if (next && !files.includes(next)) onChange([...files, next]);
    setPath('');
    setAdding(false);
  };
  return (
    <div className="st-chips">
      {files.map((file) => (
        <span key={file} className="st-chip" title={file}>
          <Icon name="doc" />
          <span>{fileName(file)}</span>
          <button type="button" className="st-chip-x" aria-label={`Remove ${fileName(file)}`} onClick={() => onChange(files.filter((f) => f !== file))}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="st-chip st-path"
          autoFocus
          aria-label="File path"
          placeholder="/path/to/file"
          spellCheck={false}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
            if (event.key === 'Escape') {
              event.stopPropagation();
              setPath('');
              setAdding(false);
            }
          }}
        />
      ) : (
        <button type="button" className="st-add" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} />
          Add file
        </button>
      )}
    </div>
  );
}
