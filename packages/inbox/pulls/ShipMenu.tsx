/**
 * Ship in a Reviews row's menu (approval "inbox-ship-mode"): first in the menu. On a desktop, Ship is a submenu
 * trigger: a click ships with the agent it shows (the one already on the review), and the submenu picks another. On a
 * phone, Ship opens the agent sheet. While the row ships: Ship log and Stop shipping instead. Another computer's agents
 * sit under its name (approved shot 3, "Mac mini").
 */
import { Menu } from '@base-ui/react/menu';
import { HostMark, Icon } from '../icons';
import { agentName } from '../tags';
import { BottomSheet } from '../components/BottomSheet';
import type { ShipOption } from './shipStart';
import { SailGlyph } from './ShipRow';

const detailOf = (option: ShipOption) => [agentName(option.row.host), option.projectName].filter(Boolean).join(' · ');

/** One agent row, as the reply box lists it (`ReplyRecipient`): its mark, its name and where it works, and the tick. */
function AgentRow({ option }: { option: ShipOption }) {
  const start = option.row.start;
  return (
    <>
      <span className="ib-rpick-name">
        {start && (
          <span className="ib-cp-plus" aria-hidden="true">
            <Icon name="plus" size={13} />
          </span>
        )}
        <span className="ib-atile">
          <HostMark host={option.row.host} agent={start ? null : option.row.session} />
        </span>
        {start ? (
          <>
            <span className="ib-rpick-l" dir="auto">
              {option.row.label}
            </span>
            <span className="ib-cp-stin" dir="auto">
              in {start.project}
            </span>
          </>
        ) : (
          <span className="ib-rpick-ol">
            <span className="ib-rpick-l" dir="auto">
              {option.row.label}
            </span>
            <span className="ib-rpick-d" dir="auto">
              {detailOf(option)}
            </span>
          </span>
        )}
      </span>
      <span className="ib-rpick-tick" aria-hidden="true">
        <span>
          <Icon name="check" size={12} />
        </span>
      </span>
    </>
  );
}

export interface ShipMenuProps {
  /** The row ships now: Ship log and Stop shipping. */
  shipping: boolean;
  options: readonly ShipOption[];
  /** The option Ship starts on (its id). */
  chosen: string | null;
  phone: boolean;
  portal: HTMLElement | null;
  onShip: (option: ShipOption) => void;
  /** A phone: open the agent sheet. */
  onChoose: () => void;
  onLog: () => void;
  onStop: () => void;
}

/** Ship's items, then a separator; nothing when there is nothing to ship. */
export function ShipMenuItems({ shipping, options, chosen, phone, portal, onShip, onChoose, onLog, onStop }: ShipMenuProps) {
  if (shipping) {
    return (
      <>
        <Menu.Item className="ib-pmi" label="Ship log" onClick={onLog} data-ship-log-open="">
          <SailGlyph />
          Ship log
        </Menu.Item>
        <Menu.Item className="ib-pmi" label="Stop shipping" onClick={onStop} data-ship-stop="">
          <Icon name="stop" size={15} />
          Stop shipping
        </Menu.Item>
        <Menu.Separator className="ib-pm-sep" />
      </>
    );
  }
  const pick = options.find((o) => o.id === chosen) ?? null;
  if (options.length === 0 && !pick) return null;
  const end = (
    <span className="ib-shp-end">
      {pick && <HostMark host={pick.row.host} agent={pick.row.start ? null : pick.row.session} />}
      <Icon name="chevR" size={14} />
    </span>
  );
  if (phone) {
    return (
      <>
        <Menu.Item className="ib-pmi" label="Ship" onClick={onChoose} data-ship="">
          <SailGlyph />
          Ship
          {end}
        </Menu.Item>
        <Menu.Separator className="ib-pm-sep" />
      </>
    );
  }
  const item = (option: ShipOption) => (
    <Menu.Item key={option.id} className="ib-rpick-row" label={option.row.label} onClick={() => onShip(option)} data-ship-agent={option.id} data-ship-machine={option.machine ?? undefined} data-on={option.id === chosen ? '' : undefined}>
      <AgentRow option={option} />
    </Menu.Item>
  );
  return (
    <>
      <Menu.SubmenuRoot>
        <Menu.SubmenuTrigger
          className="ib-pmi"
          label="Ship"
          data-ship=""
          onClick={(event) => {
            // One click ships with the agent it shows; the submenu picks another.
            if (!pick) return;
            event.preventBaseUIHandler();
            onShip(pick);
          }}
        >
          <SailGlyph />
          Ship
          {end}
        </Menu.SubmenuTrigger>
        <Menu.Portal container={portal ?? undefined}>
          <Menu.Positioner className="ib-pm-pos" side="right" align="start" sideOffset={2}>
            <Menu.Popup className="ib-pm ib-shp-agents" aria-label="Ship with" data-ship-agents="">
              {shipSections(options).map((section, i) =>
                section.kind === 'sep' ? (
                  <Menu.Separator key={`sep${i}`} className="ib-pm-sep" />
                ) : section.name === null ? (
                  section.options.map(item)
                ) : (
                  <Menu.Group key={`g${i}`} data-ship-group={section.name}>
                    <Menu.GroupLabel className="ib-pm-glabel">{section.name}</Menu.GroupLabel>
                    {section.options.map(item)}
                  </Menu.Group>
                ),
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.SubmenuRoot>
      <Menu.Separator className="ib-pm-sep" />
    </>
  );
}

type ShipSection = { kind: 'sep' } | { kind: 'group'; name: string | null; options: ShipOption[] };

/**
 * The list's sections, in its order: the review thread's computer's live agents, each other computer's agents under
 * its name, then (after a line) the thread's computer's "New … session" rows.
 */
export function shipSections(options: readonly ShipOption[]): ShipSection[] {
  const out: ShipSection[] = [];
  const live = options.filter((o) => o.group === null && !o.row.start);
  const starts = options.filter((o) => o.group === null && o.row.start);
  if (live.length > 0) out.push({ kind: 'group', name: null, options: live });
  for (const option of options) {
    if (option.group === null) continue;
    const last = out[out.length - 1];
    if (last?.kind === 'group' && last.name === option.group) last.options.push(option);
    else out.push({ kind: 'group', name: option.group, options: [option] });
  }
  if (out.length > 0 && starts.length > 0) out.push({ kind: 'sep' });
  if (starts.length > 0) out.push({ kind: 'group', name: null, options: starts });
  return out;
}

/** A phone's agent sheet: a tap ships with that agent. */
export function ShipAgentSheet({ open, title, options, chosen, host, onShip, onClose }: { open: boolean; title: string; options: readonly ShipOption[]; chosen: string | null; host: HTMLElement | null; onShip: (option: ShipOption) => void; onClose: () => void }) {
  const row = (option: ShipOption) => (
    <button
      key={option.id}
      type="button"
      className="ib-rpick-row ib-shp-sheet-row"
      onClick={() => onShip(option)}
      aria-pressed={option.id === chosen}
      data-ship-agent={option.id}
      data-ship-machine={option.machine ?? undefined}
      data-on={option.id === chosen ? '' : undefined}
    >
      <AgentRow option={option} />
    </button>
  );
  return (
    <BottomSheet open={open} onClose={onClose} title={title} host={host} attrs={{ 'data-ship-sheet': '' }}>
      {/* Its rows share the reply picker's row rules (`ib-rpick-row` …); the list is not `.ib-rpick`, the reply picker's page mark. */}
      <div className="ib-shp-sheet" role="group" aria-label="Ship with">
        {shipSections(options).map((section, i) =>
          section.kind === 'sep' ? (
            <div key={`sep${i}`} className="ib-pm-sep" role="separator" />
          ) : section.name === null ? (
            section.options.map(row)
          ) : (
            <div key={`g${i}`} role="group" aria-label={section.name} data-ship-group={section.name}>
              <div className="ib-pm-glabel" aria-hidden="true">
                {section.name}
              </div>
              {section.options.map(row)}
            </div>
          ),
        )}
      </div>
    </BottomSheet>
  );
}
