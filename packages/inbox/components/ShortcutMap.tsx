import { Icon } from '../icons';
import { mapColumns, present, type MapRow } from '../shortcuts/map';
import { isEditableTarget } from '../shortcuts/guards';
import { keyLive, MapKeys } from '../shortcuts/hint';
import { useTouchPhone } from '../phone';
import { setKeyHints, shortcutPrefs, useShortcutPrefs } from '../shortcuts/prefs';
import { Modal } from './Updates';

function rowBindings(row: MapRow, touchPhone: boolean): string[] {
  return row.keys.filter(present).flatMap((ref) => {
    const all = ref.scope.shortcuts[ref.action]!.bindings;
    const bindings = ref.only === undefined ? all : all.slice(ref.only, ref.only + 1);
    return touchPhone ? bindings.filter((binding) => keyLive(binding, { singleKeys: true }, ref)) : bindings;
  });
}

function mapFallback(): HTMLElement | null {
  for (const selector of ['[data-attachment-pane]', '.ib-main .ib-lbody [aria-current="true"][data-thread-id], .ib-main .ib-lbody [data-thread-id].ib-sel', 'section.ib-pane h2.ib-subject', '.ib-main .ib-lbody [data-thread-id]', '.ib-main h1', '.ib-main h2']) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => candidate.getClientRects().length > 0);
    if (el) return el;
  }
  return null;
}

export function ShortcutMap({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const prefs = useShortcutPrefs();
  const touchPhone = useTouchPhone();
  const columns = mapColumns()
    .map((groups) => groups.map((group) => ({ ...group, rows: group.rows.filter((row) => rowBindings(row, touchPhone).length > 0) })).filter((group) => group.rows.length > 0))
    .filter((groups) => groups.length > 0);
  return (
    <Modal labelledBy="ib-map-title" describedBy="ib-map-sub" onClose={onClose} testId="shortcut-map" ownKeys className="ib-map" fallbackFocus={mapFallback}>
      <div
        onKeyDown={(event) => {
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
