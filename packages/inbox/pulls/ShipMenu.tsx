/**
 * Ship in a Reviews row's menu (approval "inbox-ship-mode"): first in the menu. On a desktop, Ship is a submenu
 * trigger: a click ships with the agent it shows (the one already on the review), and the submenu picks another. On a
 * phone, Ship opens the agent sheet. While the row ships: Ship log and Stop shipping instead.
 */
import { Menu } from '@base-ui/react/menu';
import { HostMark, Icon } from '../icons';
import { agentName } from '../tags';
import { BottomSheet } from '../components/BottomSheet';
import type { PullThreadOption } from './threadTo';
import { SailGlyph } from './ShipRow';

const detailOf = (option: PullThreadOption) => [agentName(option.row.host), option.projectName].filter(Boolean).join(' · ');

/** One agent row, as the reply box lists it (`ReplyRecipient`): its mark, its name and where it works, and the tick. */
function AgentRow({ option }: { option: PullThreadOption }) {
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
  options: readonly PullThreadOption[];
  /** The option Ship starts on (its session id). */
  chosen: string | null;
  phone: boolean;
  portal: HTMLElement | null;
  onShip: (option: PullThreadOption) => void;
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
  const pick = options.find((o) => o.row.session === chosen) ?? null;
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
  const live = options.filter((o) => !o.row.start);
  const starts = options.filter((o) => o.row.start);
  const item = (option: PullThreadOption) => (
    <Menu.Item key={option.row.session} className="ib-rpick-row" label={option.row.label} onClick={() => onShip(option)} data-ship-agent={option.row.session} data-on={option.row.session === chosen ? '' : undefined}>
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
            <Menu.Popup className="ib-pm ib-rpick ib-shp-agents" aria-label="Ship with" data-ship-agents="">
              {live.map(item)}
              {live.length > 0 && starts.length > 0 && <Menu.Separator className="ib-pm-sep" />}
              {starts.map(item)}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.SubmenuRoot>
      <Menu.Separator className="ib-pm-sep" />
    </>
  );
}

/** A phone's agent sheet: a tap ships with that agent. */
export function ShipAgentSheet({ open, title, options, chosen, host, onShip, onClose }: { open: boolean; title: string; options: readonly PullThreadOption[]; chosen: string | null; host: HTMLElement | null; onShip: (option: PullThreadOption) => void; onClose: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={title} host={host} attrs={{ 'data-ship-sheet': '' }}>
      <div className="ib-rpick ib-shp-sheet" role="group" aria-label="Ship with">
        {options.map((option) => (
          <button
            key={option.row.session}
            type="button"
            className="ib-rpick-row ib-shp-sheet-row"
            onClick={() => onShip(option)}
            aria-pressed={option.row.session === chosen}
            data-ship-agent={option.row.session}
            data-on={option.row.session === chosen ? '' : undefined}
          >
            <AgentRow option={option} />
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}
