import type { ReactNode } from 'react';
import { formatShortcutBindingTokens, getShortcutPlatform, type ShortcutScopeDefinition } from '@plannotator/ui/shortcuts';
import { isTouchPhone, usePhone, useTouchPhone } from '../phone';
import { inboxAppShortcuts } from './app.shortcuts';
import { isBareBinding } from './guards';
import { shortcutPrefs, useShortcutPrefs, type ShortcutPrefs } from './prefs';

type Platform = 'mac' | 'non-mac';

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

function touchPhoneKey(ref: Pick<ShortcutRef, 'scope' | 'action'>): boolean {
  return ref.scope === inboxAppShortcuts && ref.action === 'openMap';
}

export function keyLive(binding: string, prefs: Pick<ShortcutPrefs, 'singleKeys'>, ref?: Pick<ShortcutRef, 'scope' | 'action'>): boolean {
  if (!isBareBinding(binding)) return true;
  if (!prefs.singleKeys) return false;
  return !isTouchPhone() || (ref !== undefined && touchPhoneKey(ref));
}

export function hintText(ref: ShortcutRef, platform: Platform = getShortcutPlatform()): string {
  return bindingText(bindingOf(ref), platform);
}

const KEYCAP: Record<string, string> = { '⏎': '↵', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

export function bindingText(binding: string, platform: Platform = getShortcutPlatform()): string {
  const tokens = formatShortcutBindingTokens(binding, platform).map((token) => KEYCAP[token] ?? token);
  if (binding.trim().includes(' ')) return tokens.join(' ');
  return tokens.join(platform === 'mac' ? '' : ' ');
}

export function hintShown(ref: ShortcutRef, state: { prefs: ShortcutPrefs; phone: boolean }, platform?: Platform): string | null {
  if (!state.prefs.hints || state.phone) return null;
  if (!keyLive(bindingOf(ref), state.prefs, ref)) return null;
  return hintText(ref, platform);
}

const ARIA_TOKEN: Record<string, string> = { Escape: 'Escape', Enter: 'Enter', Space: 'Space' };

export function ariaBinding(binding: string, platform: Platform = getShortcutPlatform()): string | null {
  if (binding.trim().includes(' ')) return null;
  return binding
    .split('+')
    .map((token) => {
      if (token === 'Mod') return platform === 'mac' ? 'Meta' : 'Control';
      if (token === '?') return 'Shift+?';
      return ARIA_TOKEN[token] ?? token;
    })
    .join('+');
}

export function shortcutAria(ref: Omit<ShortcutRef, 'binding'> & { only?: number }, prefs: Pick<ShortcutPrefs, 'singleKeys'> = shortcutPrefs(), platform?: Platform): string | undefined {
  const bindings = ref.scope.shortcuts[ref.action]?.bindings ?? [];
  const picked = ref.only === undefined ? bindings : bindings.slice(ref.only, ref.only + 1);
  const names = picked.filter((binding) => keyLive(binding, prefs, ref)).map((binding) => ariaBinding(binding, platform)).filter((name): name is string => name !== null);
  return names.length > 0 ? names.join(' ') : undefined;
}

export function useShortcutAria(ref: Omit<ShortcutRef, 'binding'> & { only?: number }): string | undefined {
  const prefs = useShortcutPrefs();
  return shortcutAria(ref, prefs);
}

export function useShortcutHintShown(ref: ShortcutRef): boolean {
  const prefs = useShortcutPrefs();
  const phone = usePhone();
  return hintShown(ref, { prefs, phone }) !== null;
}

export function ShortcutHint({ className = 'ib-kbd', touchOnly = false, ...ref }: ShortcutRef & { className?: string; touchOnly?: boolean }) {
  const prefs = useShortcutPrefs();
  const phone = usePhone();
  const touchPhone = useTouchPhone();
  const text = hintShown(ref, { prefs, phone: touchOnly ? touchPhone : phone });
  if (text === null) return null;
  return (
    <kbd className={className || undefined} aria-hidden="true" data-shortcut-hint={`${ref.scope.id}.${ref.action}`} data-keycap={text} />
  );
}

export function KeyCaps({ bindings, className }: { bindings: readonly string[]; className?: string }) {
  const platform = getShortcutPlatform();
  return (
    <>
      {bindings.map((binding, i) => (
        <kbd key={`${binding}-${i}`} className={className} data-keycap-binding={binding}>
          {bindingText(binding, platform)}
        </kbd>
      ))}
    </>
  );
}

const TIP_KBD = 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-none text-foreground/80';

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

export function withShortcut(text: ReactNode, ref: ShortcutRef): ReactNode {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{text}</span>
      <TipKeys {...ref} />
    </span>
  );
}

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
