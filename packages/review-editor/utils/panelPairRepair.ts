/**
 * Guard for the panel-pair self-heal effect (persisted reviewPanelView=sections
 * with a non-since-base defaultDiffType).
 *
 * Every UI writer of the coupled pair goes through config/reviewView's setters,
 * which enforce `sections ⟺ since-base`. `configStore.init()` is the one
 * non-writer that can still produce a conflicted pair, by applying a stale
 * config.json over the cookie; the App repairs that on load.
 *
 * A caller-pinned session (`--base` / `--diff-type`) must NOT repair: the
 * repair's other half is a config.json write plus a live handleDiffSwitch — a
 * settings write and a diff override triggered by a session that is defined by
 * writing nothing. The conflicted pair stays put for the reviewer's next
 * ordinary session, which is where a repair belongs.
 */
export function shouldRepairPanelPair(session: {
  openStatePinned: boolean;
  sectionsCapable: boolean;
  persistedPanelView?: string;
  defaultDiffType?: string;
}): boolean {
  if (session.openStatePinned) return false;
  if (!session.sectionsCapable) return false;
  if (session.persistedPanelView !== 'sections') return false;
  return session.defaultDiffType !== 'since-base';
}
