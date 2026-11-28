import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { PlanSummary } from '@plannotator/core/plans';
import { formatCount } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { readRoute } from '../app/route';
import { writeRoute } from '../app/writeRoute';
import { setPlanPin, usePlans } from './store';
import { factWords, pinnedPlans, projectOf, spaceFact, spaceUnread } from './spacesModel';

/**
 * The sidebar's "Spaces" row, second under Inbox (approvals "inbox-plans", "plans-home"), drawn only while Plans is
 * on. Its number is the plans that changed since you looked. Under it, the person's pinned spaces in their order
 * (approval "plans-home": pinning, after the Inbox's pinned threads): each opens its plan; its ⋯ (or a right-click)
 * holds Unpin, Move up and Move down. No drag, no new shortcut.
 */
export function PlansNav({ on, onClick, pick = (go) => go, phone = false }: { on: boolean; onClick: () => void; pick?: (go: () => void) => () => void; phone?: boolean }) {
  const snap = usePlans();
  const changed = snap.plans?.filter((p) => p.changed).length ?? 0;
  const pinned = snap.plans ? pinnedPlans(snap.plans, snap.pins) : [];
  const open = useOpenPlan();
  return (
    <>
      <button type="button" className={`ib-nav${on ? ' ib-on' : ''}`} onClick={onClick} aria-current={on ? 'page' : undefined} data-plans-nav="">
        <Icon name="map" />
        Spaces
        {changed > 0 && (
          <span className="ib-n" aria-label={`${changed} changed since you looked`}>
            {formatCount(changed)}
          </span>
        )}
      </button>
      {pinned.length > 0 && (
        <div className="ib-pins ib-space-pins" role="list" aria-label="Pinned spaces" data-space-pins="">
          {pinned.map((plan, index) => (
            <PinnedSpace key={plan.id} plan={plan} on={open === plan.id} first={index === 0} last={index === pinned.length - 1} index={index} phone={phone} onOpen={pick(() => writeRoute({ page: 'plans', project: null, thread: null, plan: plan.id }))} />
          ))}
        </div>
      )}
    </>
  );
}

/** The plan on screen, from the address (the sidebar is not told the route's plan). */
function useOpenPlan(): string | null {
  const [plan, setPlan] = useState<string | null>(() => (typeof window === 'undefined' ? null : planOf()));
  useEffect(() => {
    const read = () => setPlan(planOf());
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', read);
    };
  }, []);
  return plan;
}
const planOf = () => {
  const route = readRoute();
  return route.page === 'plans' ? (route.plan ?? null) : null;
};

type SpacePinAction = 'unpin' | 'up' | 'down';

/** Move a pinned space one up or down, or unpin it; a failed write puts the order back and says so (the store does). */
export function runSpacePin(id: string, index: number, action: SpacePinAction): void {
  void (action === 'unpin' ? setPlanPin(id, false) : setPlanPin(id, true, action === 'up' ? Math.max(0, index - 1) : index + 1));
}

/** One pinned space: the pinned threads' row (PinnedRow.tsx), with the plan's unread dot and its fact in the tooltip. */
function PinnedSpace({ plan, on, first, last, index, phone, onOpen }: { plan: PlanSummary; on: boolean; first: boolean; last: boolean; index: number; phone: boolean; onOpen: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(more.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const unread = spaceUnread(plan);
  const fact = factWords(spaceFact(plan, null));
  const act = (action: SpacePinAction) => {
    setMenuOpen(false);
    setContextOpen(false);
    runSpacePin(plan.id, index, action);
  };
  const items = (
    <>
      <div className="ib-pm-title" dir="auto" aria-hidden="true">
        {plan.name}
      </div>
      <Menu.Item className="ib-pmi" label="Unpin" onClick={() => act('unpin')} data-space-pin-action="unpin">
        <Icon name="pinOff" size={15} />
        Unpin
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Move up" disabled={first} onClick={() => act('up')} data-space-pin-action="up">
        <Icon name="arrowUp" size={15} />
        Move up
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Move down" disabled={last} onClick={() => act('down')} data-space-pin-action="down">
        <Icon name="arrowDown" size={15} />
        Move down
      </Menu.Item>
    </>
  );
  const row = (
    <div className="ib-pinrow" role="listitem" data-space-pin={plan.id} data-menu={menuOpen || contextOpen ? '' : undefined}>
      <Tip
        side="right"
        content={
          <span className="ib-tip-proj">
            <bdi className="ib-tip-name">{plan.name}</bdi>
            <span className="ib-tip-sub">
              <bdi>{projectOf(plan)}</bdi> · {fact}
            </span>
          </span>
        }
      >
        <button
          type="button"
          className={`ib-pin${unread ? ' ib-u' : ''}${on ? ' ib-on' : ''}`}
          onClick={onOpen}
          aria-label={[plan.name, fact, unread ? 'new' : null].filter(Boolean).join(', ')}
          aria-current={on ? 'true' : undefined}
          data-pinned-space={plan.id}
        >
          <Icon name="doc" size={15} />
          <span className="ib-name" dir="auto">
            {plan.name}
          </span>
          {unread && <span className="ib-pdot" data-k="new" aria-hidden="true" />}
        </button>
      </Tip>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Menu.Trigger ref={more} className="ib-pmore" aria-label={`${plan.name} options`} data-space-pin-more={plan.id}>
          <Icon name="dots" size={16} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={plan.name} data-space-pin-menu={plan.id}>
              {items}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
  if (phone) return row;
  return (
    <ContextMenu.Root onOpenChange={setContextOpen}>
      <ContextMenu.Trigger render={row} />
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          <ContextMenu.Popup className="ib-pm" aria-label={plan.name} data-space-pin-menu={plan.id} finalFocus={more}>
            {items}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
