/**
 * The tab row over the files beside a thread (approval "inbox-files-tabs",
 * "Tabs in the title row"): the fixed Artifacts tab with its count, one tab
 * per open file (its icon, name, comments waiting, ×), then + (the files
 * panel), then, with one file open, that file's tools (`tools`, folded into
 * the row to save the bar under it), and at the right `trailing` (the panel
 * button and the view switch). Many tabs scroll; the "N ⌄" menu lists them all
 * with "Close the others" and "Close all".
 *
 * Keys stay in the row: Left/Right/Home/End move between tabs (the tablist
 * pattern), Enter or Space shows one. No window shortcut is added.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@plannotator/ui/components/ui/dropdown-menu';
import { Icon, type IconName } from '../icons';
import { Tip } from '../components/Tip';

export interface FileTabView {
  id: string;
  name: string;
  icon: IconName;
  /** Comments waiting on the file. */
  count: number;
  /** Where it is ("docs/invoice.md", "from Claude Code"): the tab's tooltip and the menu's hint. */
  where?: string;
}

export interface FilesTabRowProps {
  artifactsCount: number;
  /** The Artifacts tab is the one on screen (no file shown). */
  artifactsOn: boolean;
  onArtifacts: () => void;
  tabs: readonly FileTabView[];
  current: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  /** + : the files panel, its filter focused. */
  onPlus: () => void;
  /** The one open file's tools, folded into the row; null when they sit in the bar under it. */
  tools?: ReactNode;
  trailing?: ReactNode;
}

export function FilesTabRow(props: FilesTabRowProps) {
  const { tabs, current, artifactsOn } = props;
  const rowRef = useRef<HTMLDivElement>(null);
  const fold = props.tools != null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tab = (event.target as HTMLElement).closest?.<HTMLElement>('[role="tab"]');
    if (!tab || event.altKey || event.ctrlKey || event.metaKey) return;
    const all = [...(rowRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const at = all.indexOf(tab);
    let to = -1;
    if (event.key === 'ArrowRight') to = Math.min(all.length - 1, at + 1);
    else if (event.key === 'ArrowLeft') to = Math.max(0, at - 1);
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = all.length - 1;
    else return;
    event.preventDefault();
    all[to]?.focus();
  };
  return (
    <div className={`ib-tabrow${fold ? ' ib-tabfold' : ''}`} ref={rowRef} data-files-tabs="">
      <div className="ib-tablist" role="tablist" aria-label="Open files" onKeyDown={onKeyDown}>
        <span className={`ib-tab ib-tabfixed${artifactsOn ? ' ib-on' : ''}`} role="presentation">
          <Tip content="Every file in this thread">
            <button type="button" role="tab" aria-selected={artifactsOn} tabIndex={artifactsOn ? 0 : -1} className="ib-tsel" onClick={props.onArtifacts} data-artifacts-tab="">
              <Icon name="artifacts" size={14} />
              <span className="ib-tl">Artifacts</span>
              <span className="ib-tcm ib-tcm-q">{props.artifactsCount}</span>
            </button>
          </Tip>
        </span>
        {tabs.length > 0 && <span className="ib-tdiv" aria-hidden="true" />}
        <div className="ib-tscroll">
          {tabs.map((tab) => {
            const on = !artifactsOn && tab.id === current;
            return (
              <span key={tab.id} className={`ib-tab${on ? ' ib-on' : ''}`} role="presentation" data-tab-id={tab.id}>
                <Tip content={tab.where ? `${tab.name} · ${tab.where}` : tab.name}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    className="ib-tsel"
                    onClick={() => props.onSelect(tab.id)}
                    onAuxClick={(e) => {
                      // A middle click closes the tab, as browsers and editors do.
                      if (e.button === 1) props.onClose(tab.id);
                    }}
                    data-file-tab={tab.id}
                  >
                    <Icon name={tab.icon} size={14} />
                    <span className="ib-tl">{tab.name}</span>
                  </button>
                </Tip>
                <span className="ib-tend">
                  {tab.count > 0 && (
                    <span className="ib-tcm" aria-label={`${tab.count} comment${tab.count === 1 ? '' : 's'}`}>
                      {tab.count}
                    </span>
                  )}
                  <button type="button" className="ib-tx" onClick={() => props.onClose(tab.id)} aria-label={`Close ${tab.name}`} tabIndex={-1} data-tab-close={tab.id}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              </span>
            );
          })}
        </div>
      </div>
      <Tip content="Open a file">
        <button type="button" className="ib-iconbtn ib-tplus" aria-label="Open a file" onClick={props.onPlus} data-tab-plus="">
          <Icon name="plus" size={16} />
        </button>
      </Tip>
      {fold && (
        <>
          <span className="ib-tdiv" aria-hidden="true" />
          {props.tools}
        </>
      )}
      <span className="ib-sp" />
      {tabs.length > 1 && (
        <DropdownMenu>
          <Tip content="Open files">
            <DropdownMenuTrigger render={<button type="button" className="ib-tovf" aria-label={`Open files, ${tabs.length}`} data-tabs-menu="" />}>
              {tabs.length}
              <Icon name="chevD" size={13} />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[16rem]" finalFocus={false}>
            <DropdownMenuLabel>Open files · {tabs.length}</DropdownMenuLabel>
            {tabs.map((tab) => (
              <DropdownMenuItem key={tab.id} onClick={() => props.onSelect(tab.id)} data-tabs-menu-item={tab.id}>
                <Icon name={tab.icon} size={14} />
                <span className="ib-tm-name">{tab.name}</span>
                {tab.count > 0 && <span className="ib-tm-n">{tab.count}</span>}
                {tab.where && <span className="ib-tm-where">{tab.where}</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={props.onCloseOthers} disabled={artifactsOn || current === null}>
              Close the others
            </DropdownMenuItem>
            <DropdownMenuItem onClick={props.onCloseAll}>Close all</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {props.trailing}
    </div>
  );
}
