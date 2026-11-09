/**
 * The shortcut map (approval "inbox-keyboard-shortcuts"): every Inbox key in
 * one dialog, opened with `?` or the keyboard button beside light and dark.
 * Its rows are read from the registry (shortcuts/), so a key that changes
 * there changes here; MAP_COLUMNS (shortcuts/map.ts) only says which actions
 * share a row and in what order. A test (shortcutMap.test.ts) fails when a
 * registry action is in no row, so a new key cannot be left off the map.
 *
 * A native modal (Updates.tsx `Modal`): focus stays inside, Escape or `?`
 * closes it, focus goes back to what opened it. On the phone layout there is
 * no button: `?` opens it (a narrow desktop window, a phone's hardware keyboard).
 */
import { Icon } from '../icons';
import { mapColumns, present, type MapRow } from '../shortcuts/map';
import { isEditableTarget } from '../shortcuts/guards';
import { keyLive, MapKeys } from '../shortcuts/hint';
import { useTouchPhone } from '../phone';
import { setKeyHints, shortcutPrefs, useShortcutPrefs } from '../shortcuts/prefs';
import { Modal } from './Updates';

/** A row's keys; on a touch phone only the ones that act there (`?` and the chords, Esc, Enter, the arrows). */
function rowBindings(row: MapRow, touchPhone: boolean): string[] {
  return row.keys.filter(present).flatMap((ref) => {
    const all = ref.scope.shortcuts[ref.action]!.bindings;
    const bindings = ref.only === undefined ? all : all.slice(ref.only, ref.only + 1);
    return touchPhone ? bindings.filter((binding) => keyLive(binding, { singleKeys: true }, ref)) : bindings;
  });
}

/** Where focus goes when the map closes and nothing focusable opened it (a cold page, `?` from nowhere): what is on screen. */
function mapFallback(): HTMLElement | null {
  for (const selector of ['[data-attachment-pane]', '.ib-main .ib-lbody [aria-current="true"][data-thread-id], .ib-main .ib-lbody [data-thread-id].ib-sel', 'section.ib-pane h2.ib-subject', '.ib-main .ib-lbody [data-thread-id]', '.ib-main h1', '.ib-main h2']) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => candidate.getClientRects().length > 0);
    if (el) return el;
  }
  return null;
}

export function ShortcutMap({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const prefs = useShortcutPrefs();
  // A touch phone (a hardware keyboard opened it with `?`): only the keys that act there, and no way to the
  // Keyboard settings, which a touch phone does not show.
  const touchPhone = useTouchPhone();
  const columns = mapColumns()
    .map((groups) => groups.map((group) => ({ ...group, rows: group.rows.filter((row) => rowBindings(row, touchPhone).length > 0) })).filter((group) => group.rows.length > 0))
    .filter((groups) => groups.length > 0);
  return (
    <Modal labelledBy="ib-map-title" describedBy="ib-map-sub" onClose={onClose} testId="shortcut-map" ownKeys className="ib-map" fallbackFocus={mapFallback}>
      <div
        onKeyDown={(event) => {
          // `?` again closes it, as it opened it: a single key, so not with Single-key shortcuts off.
          if (event.key === '?' && shortcutPrefs().singleKeys && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target as Element)) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="ib-dlg-head ib-map-head">
          <h2 id="ib-map-title">Keyboard shortcuts</h2>
          <button type="button" className="ib-map-x" aria-label="Close" onClick={onClose} data-map-close="">
            <Icon name="x" size={16} />
          </button>
        </div>
        <p className="ib-sub" id="ib-map-sub">
          {touchPhone
            ? 'On this device only ? and the keys with ⌘, Ctrl, Esc, Enter and the arrows work. Esc closes this.'
            : prefs.singleKeys
              ? 'Single keys work when you are not typing. Esc closes this.'
              : 'Single-key shortcuts are off: only the keys with ⌘, Ctrl, Esc, Enter and the arrows work. Esc closes this.'}
        </p>
        <div className="ib-map-cols">
          {columns.map((groups, c) => (
            <div key={c} className="ib-map-col">
              {groups.map((group) => (
                <section key={group.title} className="ib-map-group" aria-label={group.title}>
                  <h3>{group.title}</h3>
                  <dl>
                    {group.rows.map((row) => {
                      const first = row.keys.find(present)!;
                      const bindings = rowBindings(row, touchPhone);
                      const joined = row.keys.length === 1 && bindings.length > 1;
                      return (
                        <div key={`${first.scope.id}.${first.action}`} className="ib-map-row" data-map-row={`${first.scope.id}.${first.action}`}>
                          <dt>{row.label ?? first.scope.shortcuts[first.action]!.description}</dt>
                          <dd>
                            {bindings.map((binding, i) => (
                              <span key={binding} className="ib-mapkeys">
                                {i > 0 && joined && <span className="ib-mapor">or</span>}
                                <MapKeys binding={binding} />
                              </span>
                            ))}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </section>
              ))}
            </div>
          ))}
        </div>
        {!touchPhone && (
        <div className="ib-map-foot">
          <label className="ib-map-hints">
            <button type="button" role="switch" className="ib-sw" aria-checked={prefs.hints} aria-labelledby="ib-map-hints-l" onClick={() => setKeyHints(!prefs.hints)} data-map-hints="" />
            <span id="ib-map-hints-l">Show keys on buttons</span>
          </label>
          <button type="button" className="ib-lnk ib-map-set" onClick={onSettings} data-map-settings="">
            {prefs.singleKeys ? 'Turn single keys off in Settings → General' : 'Turn single keys on in Settings → General'}
          </button>
        </div>
        )}
      </div>
    </Modal>
  );
}
