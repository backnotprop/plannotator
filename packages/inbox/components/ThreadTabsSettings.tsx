import { Switch } from './SoundRow';

/** Settings → Capabilities → Thread tabs (config.json `inboxThreadTabs`, `inboxThreadTabsCountAnchored`; threadTabs.ts): its switch, and while on, what the main tab counts. */
export function ThreadTabsRows({
  threadTabs,
  onToggle,
  onToggleCountAnchored,
}: {
  threadTabs: { on: boolean; count_anchored: boolean };
  onToggle: (next: boolean) => void;
  onToggleCountAnchored?: (next: boolean) => void;
}) {
  return (
    <>
      <div className="ib-prow" data-settings-thread-tabs="">
        <span className="ib-txt">
          <span className="ib-l" id="ib-thread-tabs-label">
            Thread tabs
          </span>
          <span className="ib-desc">
            A tab at <code>#thread=…&amp;alone</code> shows that thread only, with its own title and icon, and notifies for it alone. Open one with ⌘ or Ctrl-click on a thread. The main tab leaves those threads out of its counts, and <code>plannotator inbox --open</code> goes to the thread's own tab.
          </span>
        </span>
        <span className="ib-ctl">
          <Switch on={threadTabs.on} labelledBy="ib-thread-tabs-label" onClick={() => onToggle(!threadTabs.on)} />
        </span>
      </div>
      {threadTabs.on && onToggleCountAnchored && (
        <div className="ib-prow" data-settings-thread-tabs-count="">
          <span className="ib-txt">
            <span className="ib-l" id="ib-thread-tabs-count-label">
              Count threads open in their own tab
            </span>
            <span className="ib-desc">Include them in the main tab's title, icon and app badge.</span>
          </span>
          <span className="ib-ctl">
            <Switch on={threadTabs.count_anchored} labelledBy="ib-thread-tabs-count-label" onClick={() => onToggleCountAnchored(!threadTabs.count_anchored)} />
          </span>
        </div>
      )}
    </>
  );
}
