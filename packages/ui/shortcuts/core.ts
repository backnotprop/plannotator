import { isMac } from '../utils/platform';

export type ShortcutPlatform = 'mac' | 'non-mac' | 'cross-platform';

export interface ShortcutDefinition {
  description: string;
  /** Alternative bindings for the same action, shown as “or” in the shortcuts UI. */
  bindings: string[];
  section: string;
  hint?: string;
  preventDefault?: boolean;
  /** Stable help-menu ordering within a section, without relying on object key order. */
  displayOrder?: number;
}

export interface ShortcutScopeDefinition<TAction extends string = string> {
  id: string;
  title: string;
  shortcuts: Record<TAction, ShortcutDefinition>;
}

export interface ShortcutEntry extends ShortcutDefinition {
  scopeId: string;
  scopeTitle: string;
  actionId: string;
}

export interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

export type ShortcutRegistry = readonly ShortcutScopeDefinition[];

export interface ShortcutSurface {
  slug: string;
  title: string;
  description: string;
  registry: ShortcutRegistry;
}

const NAMED_TOKENS = new Set([
  'Mod',
  'Shift',
  'Alt',
  'Enter',
  'Escape',
  'Tab',
  // TODO(migration): `matchesKeyToken` does not currently match `Space` —
  // pressing Spacebar produces `event.key === ' '` (length 1), which the
  // matcher uppercases to `' '` and then compares to the literal `'Space'`,
  // always failing. Add a special case in `matchesKeyToken` (e.g.
  // `if (token === 'Space') return event.key === ' ' || event.code === 'Space'`)
  // before any scope binds Space.
  'Space',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'A-Z',
  '1-0',
  'hold',
  // Punctuation keys used as shortcut targets. Add new ones as needed; we
  // whitelist explicitly so typos like `Cmd` instead of `Mod` keep failing
  // validation.
  '.',
  '[',
  ']',
]);

for (let n = 1; n <= 12; n += 1) {
  NAMED_TOKENS.add(`F${n}`);
}

const MODIFIER_TOKENS = new Set(['Mod', 'Shift', 'Alt']);

export function defineShortcutScope<TAction extends string>(scope: ShortcutScopeDefinition<TAction>): ShortcutScopeDefinition<TAction> {
  return scope;
}

function isSingleLetter(token: string): boolean {
  return /^[A-Z]$/.test(token);
}

function isSingleDigit(token: string): boolean {
  return /^[0-9]$/.test(token);
}

function getBindingTokens(binding: string): string[] {
  return binding.trim().split(/[+\s]+/).filter(Boolean);
}

function getBindingGroups(binding: string): string[][] {
  return binding.trim().split(/\s+/).filter(Boolean).map(group => group.split('+').filter(Boolean));
}

/**
 * Parse a double-tap binding like `"Alt Alt"` and return the key name.
 * Returns null for non-double-tap bindings.
 */
export function parseDoubleTapBinding(binding: string): string | null {
  const groups = getBindingGroups(binding);
  if (groups.length !== 2) return null;
  if (groups[0].length !== 1 || groups[1].length !== 1) return null;
  if (groups[0][0] !== groups[1][0]) return null;
  if (groups[1][0] === 'hold') return null;
  return groups[0][0];
}

/**
 * Check if a KeyboardEvent matches a named key token (for sequential/stateful matching).
 * Unlike `matchesShortcutBinding`, this matches a single key identity without modifier checks.
 */
export function matchesKeyName(event: KeyboardEvent, keyName: string): boolean {
  if (keyName === 'Alt') return event.key === 'Alt';
  if (keyName === 'Shift') return event.key === 'Shift';
  if (keyName === 'Mod') return event.key === 'Meta' || event.key === 'Control';
  return matchesKeyToken(event, keyName);
}

function isNormalizedToken(token: string): boolean {
  return NAMED_TOKENS.has(token) || isSingleLetter(token) || isSingleDigit(token);
}

function normalizeShortcutEntry(
  scope: ShortcutScopeDefinition,
  actionId: string,
  shortcut: ShortcutDefinition,
): ShortcutEntry {
  return {
    ...shortcut,
    scopeId: scope.id,
    scopeTitle: scope.title,
    actionId,
  };
}

export function listScopeShortcuts(
  scope: ShortcutScopeDefinition,
  options?: { actionIds?: readonly string[] },
): ShortcutEntry[] {
  const allowedActionIds = options?.actionIds ? new Set(options.actionIds) : null;
  const shortcuts: ShortcutEntry[] = [];

  for (const [actionId, shortcut] of Object.entries(scope.shortcuts)) {
    if (allowedActionIds && !allowedActionIds.has(actionId)) continue;

    shortcuts.push(normalizeShortcutEntry(scope, actionId, shortcut));
  }

  return shortcuts;
}

export function validateShortcutRegistry(registry: ShortcutRegistry): string[] {
  const errors: string[] = [];
  const scopeIds = new Set<string>();

  for (const scope of registry) {
    if (scopeIds.has(scope.id)) {
      errors.push(`Duplicate shortcut scope id: ${scope.id}`);
    }
    scopeIds.add(scope.id);

    for (const [actionId, shortcut] of Object.entries(scope.shortcuts)) {
      const id = `${scope.id}.${actionId}`;

      if (!shortcut.section.trim()) {
        errors.push(`Shortcut ${id} is missing a section.`);
      }

      if (!shortcut.description.trim()) {
        errors.push(`Shortcut ${id} is missing a description.`);
      }

      if (shortcut.bindings.length === 0) {
        errors.push(`Shortcut ${id} must define at least one binding.`);
      }

      for (const binding of shortcut.bindings) {
        if (!binding.trim()) {
          errors.push(`Shortcut ${id} contains an empty binding.`);
          continue;
        }

        for (const token of getBindingTokens(binding)) {
          if (!isNormalizedToken(token)) {
            errors.push(`Shortcut ${id} uses non-normalized token \`${token}\` in binding \`${binding}\`.`);
          }
        }
      }
    }
  }

  return errors;
}

export function createShortcutRegistry<TRegistry extends ShortcutRegistry>(registry: TRegistry): TRegistry {
  const errors = validateShortcutRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Invalid shortcut registry:\n- ${errors.join('\n- ')}`);
  }
  return registry;
}

export function mergeShortcutRegistries(...registries: ShortcutRegistry[]): ShortcutRegistry {
  return createShortcutRegistry(registries.flat());
}

export function getShortcutScope(registry: ShortcutRegistry, scopeId: string): ShortcutScopeDefinition | undefined {
  return registry.find(scope => scope.id === scopeId);
}

export function getShortcut(
  registry: ShortcutRegistry,
  scopeId: string,
  actionId: string,
): ShortcutEntry | undefined {
  const scope = getShortcutScope(registry, scopeId);
  const shortcut = scope?.shortcuts[actionId];
  return scope && shortcut ? normalizeShortcutEntry(scope, actionId, shortcut) : undefined;
}

export function listRegistryShortcuts(registry: ShortcutRegistry): ShortcutEntry[] {
  const shortcuts: ShortcutEntry[] = [];

  for (const scope of registry) {
    shortcuts.push(...listScopeShortcuts(scope));
  }

  return shortcuts;
}

export function listShortcutSections(shortcuts: readonly ShortcutEntry[]): ShortcutSection[] {
  const sections = new Map<string, ShortcutEntry[]>();

  for (const shortcut of shortcuts) {
    const existing = sections.get(shortcut.section);
    if (existing) {
      existing.push(shortcut);
    } else {
      sections.set(shortcut.section, [shortcut]);
    }
  }

  return Array.from(sections.entries()).map(([title, sectionShortcuts]) => ({
    title,
    shortcuts: [...sectionShortcuts].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.description.localeCompare(b.description)),
  }));
}

export function listRegistryShortcutSections(registry: ShortcutRegistry): ShortcutSection[] {
  return listShortcutSections(listRegistryShortcuts(registry));
}

export function getShortcutPlatform(): Exclude<ShortcutPlatform, 'cross-platform'> {
  return isMac ? 'mac' : 'non-mac';
}

function formatKeycapToken(token: string, platform: Exclude<ShortcutPlatform, 'cross-platform'>): string {
  if (platform === 'mac') {
    if (token === 'Mod') return '⌘';
    if (token === 'Alt') return '⌥';
    if (token === 'Shift') return '⇧';
    if (token === 'Enter') return '⏎';
    if (token === 'Escape') return 'Esc';
  }

  if (platform === 'non-mac') {
    if (token === 'Mod') return 'Ctrl';
    if (token === 'Enter') return '↵';
    if (token === 'Escape') return 'Esc';
  }

  return token;
}

function formatTextToken(token: string, platform: ShortcutPlatform): string {
  if (token === 'Mod') {
    if (platform === 'mac') return 'Cmd';
    if (platform === 'non-mac') return 'Ctrl';
    return 'Cmd/Ctrl';
  }

  if (token === 'Alt') {
    return platform === 'mac' ? 'Option' : 'Alt';
  }

  if (token === 'Escape') return 'Escape';
  if (token === 'hold') return 'hold';
  return token;
}

export function formatShortcutBindingTokens(
  binding: string,
  platform: Exclude<ShortcutPlatform, 'cross-platform'> = getShortcutPlatform(),
): string[] {
  const doubleTapKey = parseDoubleTapBinding(binding);
  if (doubleTapKey) {
    return [formatKeycapToken(doubleTapKey, platform), '×2'];
  }

  return getBindingTokens(binding).map(token => formatKeycapToken(token, platform));
}

export function formatShortcutBindingText(
  binding: string,
  platform: ShortcutPlatform = 'cross-platform',
): string {
  const groups = getBindingGroups(binding);

  if (groups.length === 2 && groups[1].length === 1 && groups[1][0] === 'hold' && groups[0].length === 1) {
    return `Hold ${formatTextToken(groups[0][0], platform)}`;
  }

  const doubleTapKey = parseDoubleTapBinding(binding);
  if (doubleTapKey) {
    return `Double-tap ${formatTextToken(doubleTapKey, platform)}`;
  }

  return groups
    .map(group => group.map(token => formatTextToken(token, platform)).join('+'))
    .join(' then ');
}

export function formatShortcutBindingsText(
  bindings: string[],
  platform: ShortcutPlatform = 'cross-platform',
): string {
  return bindings.map(binding => formatShortcutBindingText(binding, platform)).join(' or ');
}

function getDigitCode(event: KeyboardEvent): string | null {
  const code = typeof event.code === 'string' ? event.code : '';
  const match = code.match(/^Digit([0-9])$/);
  return match ? match[1] : null;
}

export function getShortcutDigit(event: KeyboardEvent): number | null {
  const parsed = Number.parseInt(event.key, 10);
  if (!Number.isNaN(parsed)) return parsed;

  const digitCode = getDigitCode(event);
  return digitCode === null ? null : Number.parseInt(digitCode, 10);
}

function matchesKeyToken(event: KeyboardEvent, token: string): boolean {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const shortcutDigit = getShortcutDigit(event);

  if (token === 'A-Z') {
    return /^[A-Z]$/.test(key);
  }

  if (token === '1-0') {
    return /^[0-9]$/.test(key) || shortcutDigit !== null;
  }

  if (isSingleLetter(token)) {
    return key === token;
  }

  if (isSingleDigit(token)) {
    return key === token || String(shortcutDigit ?? '') === token;
  }

  return key === token;
}

export function matchesShortcutBinding(event: KeyboardEvent, binding: string): boolean {
  if (binding.includes(' ') || binding.includes('hold')) {
    return false;
  }

  const tokens = binding.split('+').filter(Boolean);
  if (tokens.length === 0) return false;

  const requiresMod = tokens.includes('Mod');
  const requiresShift = tokens.includes('Shift');
  const requiresAlt = tokens.includes('Alt');
  const keyTokens = tokens.filter(token => !MODIFIER_TOKENS.has(token));
  if (keyTokens.length !== 1) return false;

  const keyToken = keyTokens[0];
  const shiftMatches = requiresShift === event.shiftKey || (!requiresShift && keyToken === 'A-Z' && event.shiftKey);

  if (requiresMod !== (event.metaKey || event.ctrlKey)) return false;
  if (!shiftMatches) return false;
  if (requiresAlt !== event.altKey) return false;

  return matchesKeyToken(event, keyToken);
}

export function getMatchingShortcutBindingIndex(event: KeyboardEvent, bindings: string[]): number {
  return bindings.findIndex(binding => matchesShortcutBinding(event, binding));
}
