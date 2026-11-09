/**
 * Settings → General → Keyboard (approval "inbox-keyboard-shortcuts"): the
 * two keyboard settings, both on by default, kept in this window's cookies
 * (shortcuts/prefs.ts). Not on a touch phone, where single keys are off (`isTouchPhone`); a narrow desktop window
 * keeps its keys, so it keeps the setting too.
 */
import { formatShortcutBindingText, getShortcutPlatform } from '@plannotator/ui/shortcuts';
import { useTouchPhone } from '../phone';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import { bindingOf } from '../shortcuts/hint';
import { setKeyHints, setSingleKeys, useShortcutPrefs } from '../shortcuts/prefs';
import { inboxSearchShortcuts } from '../search/searchShortcut';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';

const words = (binding: string) => formatShortcutBindingText(binding, getShortcutPlatform());

export function KeyboardSettings() {
  const prefs = useShortcutPrefs();
  const touchPhone = useTouchPhone();
  if (touchPhone) return null;
  const letters = (['markRead', 'reply', 'nextThread'] as const).map((action) => bindingOf({ scope: inboxThreadShortcuts, action })).join(', ');
  // A shifted letter is a single key too (WCAG 2.1.4): it turns off with them.
  const shifted = words(bindingOf({ scope: inboxThreadShortcuts, action: 'nextMessage' }));
  const chords = [bindingOf({ scope: inboxSearchShortcuts, action: 'openSearch' }), bindingOf({ scope: inboxThreadShortcuts, action: 'send' })].map(words).join(', ');
  const map = bindingOf({ scope: inboxAppShortcuts, action: 'openMap' });
  return (
    <section className="ib-sgroup" data-settings-keyboard="" aria-labelledby="ib-g-keyboard">
      <h2 id="ib-g-keyboard">Keyboard</h2>
      <div className="ib-card">
        <div className="ib-prow">
          <span className="ib-txt">
            <span className="ib-l" id="ib-single-keys-label">
              Single-key shortcuts
            </span>
            <span className="ib-desc" id="ib-single-keys-desc">
              {letters} and the others ({shifted} too) work when you are not typing. Turn them off if you use speech input or your screen reader&apos;s quick keys. {chords} and Escape always
              work.
            </span>
          </span>
          <span className="ib-ctl">
            <button
              type="button"
              role="switch"
              className="ib-sw"
              aria-checked={prefs.singleKeys}
              aria-labelledby="ib-single-keys-label"
              aria-describedby="ib-single-keys-desc"
              onClick={() => setSingleKeys(!prefs.singleKeys)}
              data-settings-single-keys=""
            />
          </span>
        </div>
        <div className="ib-prow">
          <span className="ib-txt">
            <span className="ib-l" id="ib-key-hints-label">
              Show keys on buttons
            </span>
            <span className="ib-desc" id="ib-key-hints-desc">
              The key beside a button or in its tooltip, like the E on Mark read. Every key is listed under {map} and behind the keyboard button by the light and dark
              switch.
            </span>
          </span>
          <span className="ib-ctl">
            <button
              type="button"
              role="switch"
              className="ib-sw"
              aria-checked={prefs.hints}
              aria-labelledby="ib-key-hints-label"
              aria-describedby="ib-key-hints-desc"
              onClick={() => setKeyHints(!prefs.hints)}
              data-settings-key-hints=""
            />
          </span>
        </div>
      </div>
    </section>
  );
}
