import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxAgent, InboxListRow } from '@plannotator/core/inbox-types';
import { agentAsListed, agentIsNamed, useInboxAgents } from '../agentsList';
import { ProjectNameField } from '../components/ProjectRow';
import { Icon } from '../icons';
import { awayLine, isAway, machineNotice, machineTakes, type MachinesModel } from '../machines';
import type { MachineView } from '../api';
import { MachineSidebarWord } from '../components/MachineUpdate';
import { Tip } from '../components/Tip';
import { AgentMark, type AgentMarkPicks } from './AgentMark';
import { GOGGLES_FRAME, GOGGLES_LENSES, GOGGLES_MOUTH } from './goggles';
import { agentFacts, agentHostName, agentRowName, agentsGroups, type AgentEntry } from './model';

/**
 * The sidebar's Agents section (approval "inbox-agents-section", and the owner's rulings of 2026-11-09), in place
 * of Machines: a section like Projects, straight on the sidebar's ground with no panel behind it. Its heading is
 * "Agents" with the Plannotator goggles in the heading grey; while it is open the heading carries two buttons, +
 * (Add agent) and laptop-plus (Add machine); closed, it is the heading alone: no row, no
 * machine name, not even for the thread or the machine on show (the owner, 2026-11-09: "It's a human-controlled list";
 * unlike Pinned and Projects, which keep where you are). Only a press on its heading opens or closes it.
 * Under it the agents, each a 24 px animated mark (motion.ts) and its name; the mark is a button of its own over the
 * row's (AgentMark.tsx: a click steps its face, a rest of the pointer opens its face picker). A machine that has no agent shows nothing.
 * While agents show from more than one machine, each machine's name is a small quiet grey caption above its agents
 * (still the machine's filter, as its Machines row was) and the agents sit a small step in; with one machine there is
 * no caption, only the agents. No counts and no state marks; no lines; roomier gaps between machines. A click on an
 * agent filters the list to its threads, as a machine's caption does, and opens none of them; a second click shows
 * everything again. An agent with no thread in the window has nothing to filter: a click messages it (New message).
 * Its hover card says where and when it started, and its project.
 *
 * Its menu is a project row's (ProjectRow.tsx): ⋯ on hover, keyboard focus and while open (always on a phone, where
 * the menu is a sheet), and the same menu on a right-click. Rename… turns the row into the project rename field; an
 * empty name, like Reset name, goes back to the agent's own name (agents/agentNames.ts).
 *
 * Its data is the list's `agents` (agentsList.ts): drawing the section is what makes the window read the list again
 * on `event: deliveries` with `agents`.
 */
export interface AgentsSectionProps {
  machines: MachinesModel;
  /** The rows the window has (every section), where an agent's threads are found. */
  rows: readonly InboxListRow[];
  /** The machine the list shows (a caption's filter), or null. */
  machineId: string | null;
  /** The agent the list shows (its filter): its row carries the selection fill. */
  agentId: string | null;
  page: string;
  closed: boolean;
  onToggle: () => void;
  labelId: string;
  bodyId: string;
  /** The section header (shared with Pinned and Projects), drawn with the goggles. */
  header: (icon: ReactNode) => ReactNode;
  onMachine?: (machineId: string) => void;
  onMachineUpdate?: (machineId: string) => void;
  /** Show one agent's threads (`#agent=<id>`); null: everything again. */
  onAgentFilter: (agentId: string | null) => void;
  /** A live agent with no thread in the window: New message to it. */
  onMessageAgent: (session: string, opener: HTMLElement) => void;
  /** Add agent: New message with a new session chosen. */
  onAddAgent: (opener: HTMLElement) => void;
  /** Add machine: Settings → Machines, where a machine is linked. Absent on an Inbox that cannot link. */
  onAddMachine?: () => void;
  /** Wraps a navigation (closes the phone sheet first). */
  pick: (go: () => void) => () => void;
  /** A phone: ⋯ always shown, the menu a sheet from the bottom edge, no right-click. */
  phone?: boolean;
  /**
   * Rename… and Reset name: a name for the agent, or null for its own again (`own`: the name it then shows). Resolves
   * true once the name is kept. Absent: no menu.
   */
  onRename?: (agent: InboxAgent, name: string | null, own: string) => Promise<boolean>;
  /** Says a line in the window's live region (the rename field's refusals). */
  announce?: (text: string) => void;
}

/** The Plannotator goggles, one shape in the current colour (the heading's grey), for both themes. */
export function GogglesMark() {
  return (
    <svg className="ib-ic ib-agents-mk" viewBox="142 141.6 740 740" aria-hidden="true" focusable="false">
      <g transform="scale(0.5)">
        <path fillRule="evenodd" d={GOGGLES_FRAME} />
      </g>
      {[...GOGGLES_LENSES, GOGGLES_MOUTH].map(([x, y, width, height]) => (
        <rect key={x} x={x} y={y} width={width} height={height} />
      ))}
    </svg>
  );
}

/** Lucide's laptop with a plus on its screen, drawn like the window's other icons (24-unit grid, current colour). */
function LaptopPlus() {
  return (
    <svg className="ib-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon="laptopPlus">
      <path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM2 20h20M12 7.5v5M9.5 10h5" />
    </svg>
  );
}

function AgentTip({ entry, machine }: { entry: AgentEntry; machine: MachineView | null }) {
  const facts = agentFacts(entry, machine);
  return (
    <span className="ib-agtip" data-agent-tip="">
      <bdi className="ib-agtip-t">{facts.title}</bdi>
      <span className="ib-agtip-s">{facts.sub}</span>
      <span className="ib-agtip-st">{facts.state}</span>
      {facts.rows.length > 0 && (
        <span className="ib-agtip-dl">
          {facts.rows.map(([key, value]) => (
            <span key={key} className="ib-agtip-r">
              <span className="ib-agtip-k">{key}</span>
              <bdi className="ib-agtip-v">{value}</bdi>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** What a press on a row does: filter the list to its threads, New message to its live agent, or nothing (an agent gone quiet with no thread). */
type AgentOpens = 'filter' | 'message' | 'none';

/**
 * One agent's row. Drawn again only when what it shows changed (its agent as the list read it, its name, its thread,
 * its machine, the selection): the window draws on every read and keystroke, and a full section is 40 rows a machine.
 */
const AgentRow = memo(
  function AgentRow(props: {
    entry: AgentEntry;
    machine: MachineView | null;
    on: boolean;
    away: boolean;
    opens: AgentOpens;
    onOpen: (entry: AgentEntry, opener: HTMLElement) => void;
    phone: boolean;
    onRename?: (entry: AgentEntry, name: string | null) => Promise<boolean>;
    announce?: (text: string) => void;
    picks: AgentMarkPicks;
  }) {
    const { entry, machine, on, away } = props;
    const [menuOpen, setMenuOpen] = useState(false);
    const [contextOpen, setContextOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const more = useRef<HTMLButtonElement>(null);
    // Rename… picked: the closing menu leaves focus to the field. The field closed: ⋯ takes it.
    const toField = useRef(false);
    const backToMore = useRef(false);
    const [portal, setPortal] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => setPortal(more.current?.closest<HTMLElement>('.pn-inbox') ?? null), [renaming]);
    useEffect(() => {
      if (renaming || !backToMore.current) return;
      backToMore.current = false;
      more.current?.focus();
    }, [renaming]);
    const onRename = props.onRename;
    const named = agentIsNamed(entry.agent);
    const row = (children: ReactNode) => (
      <div
        className="ib-sbagent"
        data-sidebar-agent={entry.agent.id}
        data-agent-state={entry.agent.state}
        data-menu={menuOpen || contextOpen ? '' : undefined}
        data-renaming={renaming ? '' : undefined}
        data-agent-named={named ? '' : undefined}
      >
        {children}
      </div>
    );
    const doneRenaming = (refocus: boolean) => {
      toField.current = false;
      backToMore.current = refocus;
      setRenaming(false);
    };
    if (renaming && onRename) {
      return row(
        <ProjectNameField
          name={entry.name}
          folder={agentRowName(agentAsListed(entry.agent), entry.thread)}
          label="Agent name"
          emptyResets
          announce={props.announce}
          others={[]}
          onCancel={doneRenaming}
          onSave={async (name) => {
            // Empty on an agent with no given name: nothing to save.
            const saved = name === '' && !named ? true : await onRename(entry, name === '' ? null : name);
            if (saved) doneRenaming(true);
            return saved;
          }}
        />,
      );
    }
    const act = (action: 'rename' | 'reset') => {
      setMenuOpen(false);
      setContextOpen(false);
      if (action === 'rename') {
        toField.current = true;
        setRenaming(true);
        return;
      }
      void onRename?.(entry, null);
    };
    const items = (
      <>
        {/* The popup is named by the agent already (aria-label): the title is for the eye only. */}
        <div className="ib-pm-title" dir="auto" aria-hidden="true">
          {entry.name}
        </div>
        <Menu.Item className="ib-pmi" label="Rename…" onClick={() => act('rename')} data-agent-action="rename">
          <Icon name="pen" size={15} />
          Rename…
        </Menu.Item>
        {named && (
          <Menu.Item className="ib-pmi" label="Reset name" onClick={() => act('reset')} data-agent-action="reset">
            <Icon name="replay" size={15} />
            Reset name
          </Menu.Item>
        )}
      </>
    );
    const content = (
      <>
        <Tip content={<AgentTip entry={entry} machine={machine} />} side="right" align="start">
          <button
            type="button"
            className={`ib-proj${on ? ' ib-on' : ''}${away ? ' ib-proj-quiet' : ''}`}
            // A filter that a second press takes off: pressed while the list shows its threads.
            aria-pressed={props.opens === 'filter' || on ? on : undefined}
            aria-haspopup={props.opens === 'message' && !on ? 'dialog' : undefined}
            onClick={(event) => props.onOpen(entry, event.currentTarget)}
            data-agent-open={props.opens}
          >
            {/* The mark's place: the mark is its own button over it (AgentMark: its picker and click cycle). */}
            <span className="am-slot" aria-hidden="true" />
            <span className="ib-name" dir="auto">
              {entry.name}
            </span>
            <span className="ib-sr">, {agentHostName(entry.agent.host)}</span>
          </button>
        </Tip>
        <AgentMark id={entry.agent.id} host={entry.agent.host} name={entry.name} agent={entry.agent} picks={props.picks} />
        {onRename && (
          <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <Menu.Trigger ref={more} className="ib-pmore" aria-label={`${entry.name} options`} data-agent-more={entry.agent.id}>
              <Icon name="dots" size={16} />
            </Menu.Trigger>
            <Menu.Portal container={portal ?? undefined}>
              {props.phone && <Menu.Backdrop className="ib-pm-scrim" />}
              <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={props.phone ? '' : undefined}>
                <Menu.Popup className="ib-pm" aria-label={entry.name} data-agent-menu={entry.agent.id} finalFocus={() => !toField.current}>
                  {items}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        )}
      </>
    );
    if (props.phone || !onRename) return row(content);
    return (
      <ContextMenu.Root onOpenChange={setContextOpen}>
        <ContextMenu.Trigger render={row(content)} />
        <ContextMenu.Portal container={portal ?? undefined}>
          <ContextMenu.Positioner className="ib-pm-pos">
            {/* Focus goes back to the row's ⋯, never the page (the field takes it after Rename…). */}
            <ContextMenu.Popup className="ib-pm" aria-label={entry.name} data-agent-menu={entry.agent.id} finalFocus={() => (toField.current ? false : more.current)}>
              {items}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  },
  (a, b) =>
    a.entry.agent === b.entry.agent &&
    a.entry.name === b.entry.name &&
    a.entry.machine === b.entry.machine &&
    a.entry.thread?.id === b.entry.thread?.id &&
    a.entry.thread?.subject === b.entry.thread?.subject &&
    a.machine === b.machine &&
    a.on === b.on &&
    a.away === b.away &&
    a.opens === b.opens &&
    a.onOpen === b.onOpen &&
    a.phone === b.phone &&
    a.onRename === b.onRename &&
    a.announce === b.announce &&
    a.picks === b.picks,
);

export function AgentsSection(props: AgentsSectionProps) {
  const groupsRead = useInboxAgents();
  const groups = useMemo(() => agentsGroups(groupsRead, props.machines, props.rows), [groupsRead, props.machines, props.rows]);
  // A machine with no agent shows nothing, and a machine's name shows only while agents show from more than one
  // machine (the owner, 2026-11-09): with one, the agents alone.
  const filled = groups.filter((group) => group.agents.length > 0);
  const captions = filled.filter((group) => group.machine !== null).length > 1;
  const empty = filled.length === 0;
  const machineOn = (id: string) => props.page === 'inbox' && props.machineId === id;
  const agentOn = (entry: AgentEntry) => props.page === 'inbox' && props.agentId === entry.agent.id;
  // A launch not yet joined by its agent has no session to write to, only its thread.
  const canMessage = (entry: AgentEntry) => entry.agent.live && !entry.agent.session.startsWith('launch:');
  // Its filter on: the click takes it off. Else it filters the list to its threads, and opens none of them; with no
  // thread in the window there is nothing to filter, and a live agent gets New message.
  const open = (entry: AgentEntry, opener: HTMLElement) => {
    if (agentOn(entry)) return props.pick(() => props.onAgentFilter(null))();
    if (entry.thread) return props.pick(() => props.onAgentFilter(entry.agent.id))();
    if (canMessage(entry)) return props.pick(() => props.onMessageAgent(entry.agent.session, opener))();
  };
  // One function for every row, for as long as the section lasts: a row is not drawn again for a new closure.
  const openNow = useRef(open);
  openNow.current = open;
  const onOpen = useCallback((entry: AgentEntry, opener: HTMLElement) => openNow.current(entry, opener), []);
  // One callback for every row, as `onOpen`. `own`: the row's name without the given one.
  const renameNow = useRef(props.onRename);
  renameNow.current = props.onRename;
  const canRename = props.onRename !== undefined;
  const onRename = useMemo(
    () => (canRename ? (entry: AgentEntry, name: string | null) => renameNow.current?.(entry.agent, name, agentRowName(agentAsListed(entry.agent), entry.thread)) ?? Promise.resolve(false) : undefined),
    [canRename],
  );
  return (
    // A section like Projects, straight on the sidebar's ground (the owner, 2026-11-09: "I like it without
    // background"). Closed: its heading only. Open: its heading carries Add agent and Add machine.
    <div className="ib-agentsec" data-agents-surface="" data-closed={props.closed ? '' : undefined}>
      <div className="ib-secrow" data-agents-head="" data-one-add={props.onAddMachine ? undefined : ""}>
        {props.header(<GogglesMark />)}
        {!props.closed && (
          <Tip content="Add agent">
            <button type="button" className="ib-proj-sort ib-agents-add" aria-label="Add agent" aria-haspopup="dialog" data-agents-add="agent" onClick={(event) => props.pick(() => props.onAddAgent(event.currentTarget))()}>
              <Icon name="plus" />
            </button>
          </Tip>
        )}
        {!props.closed && props.onAddMachine && (
          <Tip content="Add machine">
            <button type="button" className="ib-proj-sort ib-agents-add" aria-label="Add machine" data-agents-add="machine" onClick={props.pick(() => props.onAddMachine?.())}>
              <LaptopPlus />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-agents-body" id={props.bodyId} role="group" aria-labelledby={props.labelId} data-agents-section="" data-flat={captions ? undefined : ''} data-closed={props.closed ? '' : undefined}>
        {empty && !props.closed && <div className="ib-side-empty ib-agents-empty">Agents show here while they run.</div>}
        {/* Closed, nothing is drawn under the heading, whatever thread or machine is open (unlike Pinned and Projects). */}
        {(props.closed ? [] : filled).map((group) => {
          const machine = group.machine;
          const rows = group.agents;
          const captionOn = captions && !!machine && machineOn(machine.id);
          const away = machine ? isAway(machine) : false;
          const notice = machine && props.onMachineUpdate ? machineNotice(machine) : null;
          // A face and a given name live on the agent's own machine (inbox-linked-marks): a linked machine's agents
          // offer them only once its list says it takes them, and never an uploaded picture, which stays here.
          const linked = machine && !machine.self ? { machine: machine.id } : null;
          const names = !linked || machineTakes(linked, props.machines, 'agent-name');
          const picks: AgentMarkPicks = !linked ? 'all' : machineTakes(linked, props.machines, 'agent-face') ? 'shared' : 'none';
          return (
            <div key={machine?.id ?? 'flat'} className="ib-agents-group" data-agents-machine={machine?.id ?? ''}>
              {machine && captions && (
                <div className="ib-mside ib-agents-cap" data-machine-notice={notice?.kind ?? undefined}>
                  <Tip content={machine.self ? 'This machine' : (awayLine(machine) ?? machine.name)} side="right">
                    <button
                      type="button"
                      className={`ib-proj ib-proj-quiet${captionOn ? ' ib-on' : ''}`}
                      onClick={props.pick(() => props.onMachine?.(machine.id))}
                      aria-current={captionOn ? 'page' : undefined}
                      data-machine={machine.id}
                      data-away={away ? '' : undefined}
                    >
                      <span className="ib-name" dir="auto">
                        {machine.name}
                      </span>
                      {away && <span className="ib-sr">, {awayLine(machine)}</span>}
                    </button>
                  </Tip>
                  {notice && <MachineSidebarWord notice={notice} name={machine.name} onPress={props.pick(() => props.onMachineUpdate?.(machine.id))} />}
                </div>
              )}
              {rows.map((entry) => (
                <AgentRow
                  key={entry.agent.id}
                  entry={entry}
                  machine={machine}
                  on={agentOn(entry)}
                  away={away}
                  opens={entry.thread ? 'filter' : canMessage(entry) ? 'message' : 'none'}
                  onOpen={onOpen}
                  phone={props.phone === true}
                  onRename={names ? onRename : undefined}
                  picks={picks}
                  announce={props.announce}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
