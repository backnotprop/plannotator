import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  INBOX_SIDEBAR_DEFAULT,
  INBOX_SIDEBAR_PRESET_ORDER,
  INBOX_SIDEBAR_PRESETS,
  inboxSidebarCanStep,
  inboxSidebarHideable,
  inboxSidebarMove,
  inboxSidebarPreset,
  inboxSidebarSame,
  inboxSidebarSetShown,
  inboxSidebarShown,
  inboxSidebarSpec,
  inboxSidebarStackOf,
  inboxSidebarStep,
  inboxSidebarToStack,
  type InboxSidebarItem,
  type InboxSidebarLayout,
  type InboxSidebarStack,
} from '@plannotator/core/inbox-sidebar';
import { GogglesMark } from '../agents/AgentsSection';
import { useInboxAgents } from '../agentsList';
import { Icon } from '../icons';
import { usePhone } from '../phone';
import { SIDEBAR_ITEM_ICON } from '../sidebarItems';
import { closeSidebarCustomizer, readSidebarLayout, useSidebarCustomizerOpen, useSidebarLayout, writeSidebarLayout } from '../sidebarLayout';

function Grip() {
  return (
    <svg className="ib-sbc-grip-ic" viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
      {[3, 8, 13].map((y) => (
        <g key={y}>
          <circle cx="2.5" cy={y} r="1.3" />
          <circle cx="7.5" cy={y} r="1.3" />
        </g>
      ))}
    </svg>
  );
}

function ItemIcon({ item }: { item: InboxSidebarItem }) {
  return item === 'agents' ? <GogglesMark /> : <Icon name={SIDEBAR_ITEM_ICON[item]} />;
}

type Drop = { stack: InboxSidebarStack; index: number };
type Drag = { item: InboxSidebarItem; y: number; dy: number; drop: Drop | null };

function dropAt(root: HTMLElement | null, layout: InboxSidebarLayout, item: InboxSidebarItem, y: number): Drop | null {
  for (const zone of root?.querySelectorAll<HTMLElement>('[data-sbc-zone]') ?? []) {
    const box = zone.getBoundingClientRect();
    if (y < box.top - 14 || y > box.bottom + 14) continue;
    const stack = zone.dataset.sbcZone as InboxSidebarStack;
    const rows = [...zone.querySelectorAll<HTMLElement>('[data-sbc-row]')].filter((el) => el.dataset.sbcRow !== item);
    const before = rows.find((row) => {
      const r = row.getBoundingClientRect();
      return y < r.top + r.height / 2;
    })?.dataset.sbcRow as InboxSidebarItem | undefined;
    const list = (stack === 'top' ? layout.top : layout.bottom).filter((other) => other !== item);
    return { stack, index: before ? list.indexOf(before) : list.length };
  }
  return null;
}

export function SidebarCustomizer({
  drawn,
  machines,
  onOpen,
}: {
  drawn: ReadonlySet<InboxSidebarItem>;
  machines?: boolean;
  onOpen?: () => void;
}) {
  const open = useSidebarCustomizerOpen();
  const phone = usePhone();
  const layout = useSidebarLayout();
  const panel = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [left, setLeft] = useState(12);
  const [drag, setDrag] = useState<Drag | null>(null);
  const close = () => closeSidebarCustomizer()?.focus({ preventScroll: true });
  useLayoutEffect(() => {
    if (!open) return;
    onOpen?.();
    const side = document.querySelector('.ib-side');
    const right = side?.getBoundingClientRect().right ?? 0;
    setLeft(Math.round(right > 0 ? right + 10 : 12));
    title.current?.focus({ preventScroll: true });
    const later = window.setTimeout(() => {
      const now = document.querySelector('.ib-side')?.getBoundingClientRect().right ?? 0;
      if (now > 0) setLeft(Math.round(now + 10));
    }, 320);
    return () => window.clearTimeout(later);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[data-sbc-move-menu]')) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  if (!open) return null;

  const preset = inboxSidebarPreset(layout);
  const drawnIn = (stack: InboxSidebarStack) => (stack === 'top' ? layout.top : layout.bottom).filter((item) => drawn.has(item));
  const startDrag = (item: InboxSidebarItem, event: ReactPointerEvent<HTMLElement>, onPress: () => void) => {
    // A touch never drags (the sheet scrolls under it): a tap is a click, which opens the grip's menu.
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const y0 = event.clientY;
    const row = event.currentTarget.closest<HTMLElement>('[data-sbc-row]');
    const dy = y0 - (row?.getBoundingClientRect().top ?? y0);
    let moved = false;
    const move = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientY - y0) < 4) return;
      moved = true;
      setDrag({ item, y: e.clientY, dy, drop: dropAt(panel.current, readSidebarLayout(), item, e.clientY) });
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (!moved) return onPress();
      const now = readSidebarLayout();
      const drop = e.type === 'pointerup' ? dropAt(panel.current, now, item, e.clientY) : null;
      if (drop) void writeSidebarLayout(inboxSidebarMove(now, item, drop.stack, drop.index));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const group = (stack: InboxSidebarStack) => {
    const items = drawnIn(stack);
    const rows: ReactNode[] = items.map((item) => <ItemRow key={item} item={item} layout={layout} drawn={drawn} lifted={drag?.item === item} onGrip={startDrag} />);
    if (drag?.drop?.stack === stack) {
      const rest = (stack === 'top' ? layout.top : layout.bottom).filter((item) => item !== drag.item);
      const before = rest[drag.drop.index];
      const at = before === undefined ? -1 : items.indexOf(before);
      rows.splice(at < 0 ? items.length : at, 0, <div key="drop" className="ib-sbc-gap" aria-hidden="true" />);
    }
    return (
      <div className="ib-sbc-zone" data-sbc-zone={stack} role="group" aria-labelledby={`ib-sbc-${stack}`}>
        <div className="ib-sbc-glabel" id={`ib-sbc-${stack}`}>
          {stack === 'top' ? 'Top' : 'Bottom'}
        </div>
        {stack === 'top' && drawn.has('logo') && <FixedRow item="logo" layout={layout} />}
        {rows.length ? rows : <div className="ib-sbc-empty">Drag items here</div>}
      </div>
    );
  };
  return (
    <>
      {phone && <div className="ib-sbc-scrim" aria-hidden="true" onClick={close} />}
      <div
        ref={panel}
        className="ib-sbc"
        role="dialog"
        aria-labelledby="ib-sbc-title"
        data-sidebar-customizer=""
        data-phone={phone ? '' : undefined}
        data-dragging={drag ? '' : undefined}
        style={phone ? undefined : { left }}
      >
        <div className="ib-sbc-head">
          <h2 id="ib-sbc-title" ref={title} tabIndex={-1}>
            Customize sidebar
          </h2>
          <button type="button" className="ib-sbc-x" aria-label="Close" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ib-sbc-start" data-sidebar-preset={preset ?? 'custom'}>
          <span className="ib-sr" id="ib-sbc-start">
            Start from
          </span>
          <span className="ib-seg ib-seg-sm" role="group" aria-labelledby="ib-sbc-start" aria-describedby={preset ? undefined : 'ib-sbc-custom'}>
            {INBOX_SIDEBAR_PRESET_ORDER.map((choice) => (
              <button
                key={choice}
                type="button"
                className="ib-seg-o"
                aria-pressed={preset === choice}
                data-on={preset === choice ? '' : undefined}
                data-preset={choice}
                onClick={() => void writeSidebarLayout(INBOX_SIDEBAR_PRESETS[choice].layout)}
              >
                {INBOX_SIDEBAR_PRESETS[choice].label}
              </button>
            ))}
          </span>
          {!preset && (
            <span className="ib-sbc-custom" id="ib-sbc-custom">
              Custom
            </span>
          )}
        </div>
        <div className="ib-sbc-body">
          {group('top')}
          <div className="ib-sbc-middle" aria-hidden="true">
            <Icon name="star" />
            <Icon name="folder" />
            Starred and Projects
          </div>
          {drawn.has('agents') && <AgentsRow layout={layout} machines={machines === true} />}
          {group('bottom')}
        </div>
        <div className="ib-sbc-foot">
          <button type="button" className="ib-btn ib-ghost ib-sm" disabled={inboxSidebarSame(layout, INBOX_SIDEBAR_DEFAULT)} onClick={() => void writeSidebarLayout(INBOX_SIDEBAR_DEFAULT)} data-sidebar-reset="">
            Reset to default
          </button>
          <button type="button" className="ib-btn ib-sm ib-pri" onClick={close} data-sidebar-done="">
            Done
          </button>
        </div>
      </div>
      {drag && (
        <div
          className="ib-sbc-ghost"
          aria-hidden="true"
          style={{ top: drag.y - drag.dy, left: (panel.current?.getBoundingClientRect().left ?? left) + 10, width: (panel.current?.getBoundingClientRect().width ?? 300) - 20 }}
        >
          <Grip />
          <ItemIcon item={drag.item} />
          {inboxSidebarSpec(drag.item).label}
        </div>
      )}
    </>
  );
}

function ShowSwitch({ item, layout }: { item: InboxSidebarItem; layout: InboxSidebarLayout }) {
  if (!inboxSidebarHideable(item)) {
    return (
      <span className="ib-sbc-lock" data-sbc-locked="">
        <Icon name="lock" />
        <span className="ib-sr">Always shown</span>
      </span>
    );
  }
  const on = inboxSidebarShown(layout, item);
  return (
    <button
      type="button"
      role="switch"
      className="ib-sw"
      aria-checked={on}
      aria-labelledby={`ib-sbc-l-${item}`}
      data-sidebar-switch={item}
      onClick={() => void writeSidebarLayout(inboxSidebarSetShown(readSidebarLayout(), item, !on))}
    />
  );
}

function AgentsRow({ layout, machines }: { layout: InboxSidebarLayout; machines: boolean }) {
  const agents = useInboxAgents();
  return agents !== null || machines ? <FixedRow item="agents" layout={layout} /> : null;
}

function FixedRow({ item, layout, sub }: { item: InboxSidebarItem; layout: InboxSidebarLayout; sub?: boolean }) {
  return (
    <div className={`ib-sbc-row${sub ? ' ib-sbc-sub' : ' ib-sbc-fixed'}`} data-off={inboxSidebarShown(layout, item) ? undefined : ''} data-sbc-fixed={item}>
      <ItemIcon item={item} />
      <span className="ib-sbc-l" id={`ib-sbc-l-${item}`}>
        {inboxSidebarSpec(item).label}
      </span>
      <ShowSwitch item={item} layout={layout} />
    </div>
  );
}

function ItemRow({
  item,
  layout,
  drawn,
  lifted,
  onGrip,
}: {
  item: InboxSidebarItem;
  layout: InboxSidebarLayout;
  drawn: ReadonlySet<InboxSidebarItem>;
  lifted: boolean;
  onGrip: (item: InboxSidebarItem, event: ReactPointerEvent<HTMLElement>, onPress: () => void) => void;
}) {
  const [menu, setMenu] = useState(false);
  const grip = useRef<HTMLButtonElement>(null);
  // A mouse or pen press is handled on its own (a drag, or the menu once it lets go): the click that follows is not.
  const pointerPress = useRef(false);
  const shown = (other: InboxSidebarItem) => drawn.has(other);
  const stack = inboxSidebarStackOf(layout, item);
  const name = inboxSidebarSpec(item).label;
  const act = (next: InboxSidebarLayout) => {
    void writeSidebarLayout(next);
  };
  return (
    <>
      <div className="ib-sbc-row" data-sbc-row={item} data-off={inboxSidebarShown(layout, item) ? undefined : ''} data-lifted={lifted ? '' : undefined}>
        <button
          ref={grip}
          type="button"
          className="ib-sbc-grip"
          aria-label={`Move ${name}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          data-sidebar-grip={item}
          onPointerDown={(event) => {
            pointerPress.current = event.button === 0 && event.pointerType !== 'touch';
            onGrip(item, event, () => setMenu(true));
          }}
          onClick={() => {
            if (pointerPress.current) {
              pointerPress.current = false;
              return;
            }
            setMenu(true);
          }}
        >
          <Grip />
        </button>
        <Menu.Root open={menu} onOpenChange={setMenu} modal={false}>
          <Menu.Portal container={grip.current?.closest<HTMLElement>('.pn-inbox') ?? undefined}>
            <Menu.Positioner className="ib-pm-pos ib-sbc-movepos" anchor={grip} side="bottom" align="start" sideOffset={4}>
              <Menu.Popup className="ib-pm" aria-label={`Move ${name}`} data-sbc-move-menu={item} finalFocus={grip}>
                <Menu.Item className="ib-pmi" disabled={!inboxSidebarCanStep(layout, item, -1, shown)} onClick={() => act(inboxSidebarStep(readSidebarLayout(), item, -1, shown))} data-sbc-move="up">
                  <Icon name="chevU" />
                  <span className="ib-pmi-l">Move up</span>
                </Menu.Item>
                <Menu.Item className="ib-pmi" disabled={!inboxSidebarCanStep(layout, item, 1, shown)} onClick={() => act(inboxSidebarStep(readSidebarLayout(), item, 1, shown))} data-sbc-move="down">
                  <Icon name="chevD" />
                  <span className="ib-pmi-l">Move down</span>
                </Menu.Item>
                <Menu.Separator className="ib-pm-sep" />
                <Menu.Item
                  className="ib-pmi"
                  onClick={() => act(inboxSidebarToStack(readSidebarLayout(), item, stack === 'top' ? 'bottom' : 'top'))}
                  data-sbc-move={stack === 'top' ? 'bottom' : 'top'}
                >
                  <Icon name={stack === 'top' ? 'arrowDown' : 'arrowUp'} />
                  <span className="ib-pmi-l">{stack === 'top' ? 'Move to bottom' : 'Move to top'}</span>
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <ItemIcon item={item} />
        <span className="ib-sbc-l" id={`ib-sbc-l-${item}`}>
          {name}
        </span>
        <ShowSwitch item={item} layout={layout} />
      </div>
      {item === 'settings' && (['shortcuts', 'theme'] as const).filter(shown).map((sub) => <FixedRow key={sub} item={sub} layout={layout} sub />)}
    </>
  );
}
