/**
 * The project rail's one choice, "When the sidebar is closed: Hide it / Keep a rail of places" (take R1, 2026-11-26):
 * in the sidebar's right-click menu (SidebarMenu.tsx), in the rail's own right-click menu (RailMenus.tsx), and in
 * Settings → General (SidebarClosedRow below), the way in on a phone. Saved with the sidebar's layout (core
 * inbox-sidebar.ts `rail`), so it follows the person to every window and the phone. Off by default.
 */
import { Menu } from '@base-ui/react/menu';
import { inboxSidebarSetRail } from '@plannotator/core/inbox-sidebar';
import { readSidebarLayout, useSidebarLayout, writeSidebarLayout } from '../sidebarLayout';

export const RAIL_CHOICE_WORDS = 'When the sidebar is closed';
export const RAIL_CHOICES = [
  { on: false, label: 'Hide it', desc: 'Rest on the left edge to peek' },
  { on: true, label: 'Keep a rail of places', desc: 'Inbox and your pinned projects and tags' },
] as const;

export const setRail = (on: boolean) => void writeSidebarLayout(inboxSidebarSetRail(readSidebarLayout(), on));

/** The choice as a menu group: two radio rows, each with its line under it. The menu stays open on a pick. */
export function RailChoiceItems({ closeOnClick = false }: { closeOnClick?: boolean }) {
  const on = useSidebarLayout().rail === true;
  return (
    <Menu.Group>
      <Menu.GroupLabel className="ib-pm-glabel">{RAIL_CHOICE_WORDS}</Menu.GroupLabel>
      <Menu.RadioGroup value={on ? 'rail' : 'hide'} onValueChange={(value: string) => setRail(value === 'rail')}>
        {RAIL_CHOICES.map((choice) => (
          <Menu.RadioItem key={choice.label} value={choice.on ? 'rail' : 'hide'} closeOnClick={closeOnClick} className="ib-pmi ib-rail-choice" label={choice.label} data-rail-choice={choice.on ? 'rail' : 'hide'}>
            <span className="ib-pmi-box" data-radio="" data-on={on === choice.on ? '' : undefined} aria-hidden="true" />
            <span className="ib-rail-choice-t">
              <span className="ib-pmi-l">{choice.label}</span>
              <span className="ib-rail-choice-d">{choice.desc}</span>
            </span>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu.Group>
  );
}

/** Settings → General, under Sidebar: the same choice as two segments. */
export function SidebarClosedRow() {
  const on = useSidebarLayout().rail === true;
  return (
    <div className="ib-prow" data-settings-rail={on ? 'rail' : 'hide'}>
      <span className="ib-txt">
        <span className="ib-l" id="ib-rail-label">
          {RAIL_CHOICE_WORDS}
        </span>
        <span className="ib-desc">Hide it, or keep a rail of Inbox and your pinned projects and tags. On a phone the pins head the sidebar.</span>
      </span>
      <span className="ib-ctl">
        <span className="ib-seg" role="radiogroup" aria-labelledby="ib-rail-label">
          {RAIL_CHOICES.map((choice) => (
            <label key={choice.label} className="ib-seg-o" data-on={on === choice.on ? '' : undefined}>
              <input type="radio" name="ib-rail" value={choice.on ? 'rail' : 'hide'} checked={on === choice.on} onChange={() => setRail(choice.on)} />
              {choice.label}
            </label>
          ))}
        </span>
      </span>
    </div>
  );
}
