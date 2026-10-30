/**
 * Every keycap and every `aria-keyshortcuts` in the Inbox, read from the
 * registry (shortcuts/index.ts): a key and its hint cannot drift apart. A
 * source test (shortcutHints.test.ts) fails on a `<kbd` or an
 * `aria-keyshortcuts` literal anywhere else in the Inbox.
 *
 * - Show keys on buttons off: no keycap is drawn; `aria-keyshortcuts` stays.
 * - Single-key shortcuts off: a single key's keycap and its
 *   `aria-keyshortcuts` both go (the key does nothing); chords stay.
 * - A phone: no keycaps (there is no keyboard to read them for).
 * - A touch phone: no single key but `?` acts, so `aria-keyshortcuts` names none of the others.
 */
import type { ReactNode } from 'react';
import { formatShortcutBindingTokens, getShortcutPlatform, type ShortcutScopeDefinition } from '@plannotator/ui/shortcuts';
import { isTouchPhone, usePhone } from '../phone';
import { inboxAppShortcuts } from './app.shortcuts';
import { isBareBinding } from './guards';
import { shortcutPrefs, useShortcutPrefs, type ShortcutPrefs } from './prefs';

type Platform = 'mac' | 'non-mac';

/** One action's key: a scope, the action, and which of its bindings to show (default the first). */
export interface ShortcutRef<TScope extends ShortcutScopeDefinition<any> = ShortcutScopeDefinition<any>> {
  scope: TScope;
  action: keyof TScope['shortcuts'] & string;
  binding?: number;
}

export function bindingOf(ref: ShortcutRef): string {
  const shortcut = ref.scope.shortcuts[ref.action];
  if (!shortcut) throw new Error(`No shortcut ${ref.scope.id}.${ref.action}`);
  const binding = shortcut.bindings[ref.binding ?? 0];
  if (!binding) throw new Error(`No binding ${ref.binding ?? 0} for ${ref.scope.id}.${ref.action}`);
  return binding;
}

/** The one single key a touch phone keeps: `?`, so a hardware keyboard still opens the map (design §5.4). */
function touchPhoneKey(ref: Pick<ShortcutRef, 'scope' | 'action'>): boolean {
  return ref.scope === inboxAppShortcuts && ref.action === 'openMap';
}

/**
 * Whether the key is in force: a single key does nothing with single keys off, nor on a touch phone (but `?`;
 * `singleKeysLive` in guards.ts), so nothing names it there.
 */
export function keyLive(binding: string, prefs: Pick<ShortcutPrefs, 'singleKeys'>, ref?: Pick<ShortcutRef, 'scope' | 'action'>): boolean {
  if (!isBareBinding(binding)) return true;
  if (!prefs.singleKeys) return false;
  return !isTouchPhone() || (ref !== undefined && touchPhoneKey(ref));
}

/**
 * The keycaps' text: ⌘K on macOS, Ctrl K elsewhere; ⌘↵ and Ctrl ↵ for Send
 * (the arrow reads as the key's label on both). A sequence keeps its space
 * (G I).
 */
export function hintText(ref: ShortcutRef, platform: Platform = getShortcutPlatform()): string {
  return bindingText(bindingOf(ref), platform);
}

const KEYCAP: Record<string, string> = { '⏎': '↵', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

/** `hintText` for a binding on its own. */
export function bindingText(binding: string, platform: Platform = getShortcutPlatform()): string {
  const tokens = formatShortcutBindingTokens(binding, platform).map((token) => KEYCAP[token] ?? token);
  if (binding.trim().includes(' ')) return tokens.join(' ');
  return tokens.join(platform === 'mac' ? '' : ' ');
}

/** The keycap's text, or null when none is drawn (hints off, a phone, a single key with single keys off). */
export function hintShown(ref: ShortcutRef, state: { prefs: ShortcutPrefs; phone: boolean }, platform?: Platform): string | null {
  if (!state.prefs.hints || state.phone) return null;
  if (!keyLive(bindingOf(ref), state.prefs, ref)) return null;
  return hintText(ref, platform);
}

const ARIA_TOKEN: Record<string, string> = { Escape: 'Escape', Enter: 'Enter', Space: 'Space' };

/** One binding in `aria-keyshortcuts` form, or null for a sequence (the attribute has no way to say "then"). */
export function ariaBinding(binding: string, platform: Platform = getShortcutPlatform()): string | null {
  if (binding.trim().includes(' ')) return null;
  return binding
    .split('+')
    .map((token) => {
      if (token === 'Mod') return platform === 'mac' ? 'Meta' : 'Control';
      // A character typed with Shift is named with it (ARIA: the modifiers held, then the key's value).
      if (token === '?') return 'Shift+?';
      return ARIA_TOKEN[token] ?? token;
    })
    .join('+');
}

/**
 * `aria-keyshortcuts` for a control: every binding of the action that is in
 * force, space-separated. It stays with hints off (a screen reader still names
 * the key); a single key with single keys off is left out.
 */
export function shortcutAria(ref: Omit<ShortcutRef, 'binding'> & { only?: number }, prefs: Pick<ShortcutPrefs, 'singleKeys'> = shortcutPrefs(), platform?: Platform): string | undefined {
  const bindings = ref.scope.shortcuts[ref.action]?.bindings ?? [];
  const picked = ref.only === undefined ? bindings : bindings.slice(ref.only, ref.only + 1);
  const names = picked.filter((binding) => keyLive(binding, prefs, ref)).map((binding) => ariaBinding(binding, platform)).filter((name): name is string => name !== null);
  return names.length > 0 ? names.join(' ') : undefined;
}

/** `shortcutAria`, redrawn when the settings change. */
export function useShortcutAria(ref: Omit<ShortcutRef, 'binding'> & { only?: number }): string | undefined {
  const prefs = useShortcutPrefs();
  return shortcutAria(ref, prefs);
}

/** Whether the action's keycap is drawn now (for a note around the keycap that goes with it). */
export function useShortcutHintShown(ref: ShortcutRef): boolean {
  const prefs = useShortcutPrefs();
  const phone = usePhone();
  return hintShown(ref, { prefs, phone }) !== null;
}

/**
 * A keycap on a button, from the registry: `<kbd data-shortcut-hint="scope.action" data-keycap="R">`.
 * `className` keeps each place's own look (`ib-kbd`, the toast's, the chip's).
 */
export function ShortcutHint({ className = 'ib-kbd', ...ref }: ShortcutRef & { className?: string }) {
  const prefs = useShortcutPrefs();
  const phone = usePhone();
  const text = hintShown(ref, { prefs, phone });
  if (text === null) return null;
  return (
    // The keycap's text is drawn by CSS from `data-keycap` (inbox.css), so it is no part of the button's own text: a
    // button reads "Reply", not "ReplyR", to anything that reads its words (its name is aria-hidden-free either way).
    <kbd className={className || undefined} aria-hidden="true" data-shortcut-hint={`${ref.scope.id}.${ref.action}`} data-keycap={text} />
  );
}

const TIP_KBD = 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-none text-foreground/80';

/** A tooltip's keycaps, one per key of the binding (⌘ ⇧ X), from the registry. */
export function TipKeys(ref: ShortcutRef) {
  const prefs = useShortcutPrefs();
  const phone = usePhone();
  if (hintShown(ref, { prefs, phone }) === null) return null;
  const binding = bindingOf(ref);
  const tokens = binding.includes(' ') ? [hintText(ref)] : formatShortcutBindingTokens(binding).map((token) => KEYCAP[token] ?? token);
  return (
    <span className="flex items-center gap-1" data-shortcut-hint={`${ref.scope.id}.${ref.action}`}>
      {tokens.map((token, index) => (
        <kbd key={`${token}-${index}`} className={TIP_KBD}>
          {token}
        </kbd>
      ))}
    </span>
  );
}

/** A tooltip's text with the action's keycaps after it ("Reply R"); just the text when none is drawn. */
export function withShortcut(text: ReactNode, ref: ShortcutRef): ReactNode {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{text}</span>
      <TipKeys {...ref} />
    </span>
  );
}

/**
 * Every key of one binding as the shortcut map draws it: one keycap per key,
 * "then" between a sequence's keys (G then I). Always drawn: the map is where
 * the keys are read, whatever the settings say.
 */
export function MapKeys({ binding }: { binding: string }) {
  const platform = getShortcutPlatform();
  const groups = binding.trim().split(/\s+/);
  return (
    <span className="ib-mapkeys">
      {groups.map((group, i) => (
        <span key={`${group}-${i}`} className="ib-mapkeys">
          {i > 0 && <span className="ib-mapor">then</span>}
          <kbd className="ib-kbd">{bindingText(group, platform)}</kbd>
        </span>
      ))}
    </span>
  );
}
