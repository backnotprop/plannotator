import { isMac, isWindows } from '../utils/platform';

export type ShortcutPlatform = 'mac' | 'non-mac' | 'cross-platform';

/** The three desktop systems a binding can differ on (VS Code's split). */
export type ShortcutOS = 'mac' | 'windows' | 'linux';

export interface ShortcutDefinition {
  description: string;
  bindings: string[];
  platformBindings?: Partial<Record<ShortcutOS, string[]>>;
  section: string;
  hint?: string;
  preventDefault?: boolean;
  displayOrder?: number;
}

export interface ShortcutScopeDefinition<TAction extends string = string> {
  id: string;
  title: string;
  shortcuts: Record<TAction, ShortcutDefinition>;
  lettersByCode?: boolean;
}

export interface ShortcutMatchOptions {
  lettersByCode?: boolean;
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
  'Ctrl',
  'Shift',
  'Alt',
  'Enter',
  'Escape',
  'Tab',
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
  '.',
  '/',
  '[',
  ']',
  '{',
  '}',
  '?',
  '$',
  '-',
]);

for (let n = 1; n <= 12; n += 1) {
  NAMED_TOKENS.add(`F${n}`);
}

const MODIFIER_TOKENS = new Set(['Mod', 'Ctrl', 'Shift', 'Alt']);
const SHIFTED_LITERAL_TOKENS = new Set(['{', '}', '?', '$']);
type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>;

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

export function parseDoubleTapBinding(binding: string): string | null {
  const groups = getBindingGroups(binding);
  if (groups.length !== 2) return null;
  if (groups[0].length !== 1 || groups[1].length !== 1) return null;
  if (groups[0][0] !== groups[1][0]) return null;
  if (groups[1][0] === 'hold') return null;
  return groups[0][0];
}

export function matchesKeyName(event: ShortcutKeyEvent, keyName: string): boolean {
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

      const allBindings = [
        ...shortcut.bindings,
        ...Object.values(shortcut.platformBindings ?? {}).flat(),
      ];
      for (const binding of allBindings) {
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

export function getShortcutOS(): ShortcutOS {
  return isMac ? 'mac' : isWindows ? 'windows' : 'linux';
}

/** The bindings that apply on a system: its own when it has some, else `bindings`. */
export function resolveShortcutBindings(
  shortcut: Pick<ShortcutDefinition, 'bindings' | 'platformBindings'>,
  os: ShortcutOS = getShortcutOS(),
): string[] {
  return shortcut.platformBindings?.[os] ?? shortcut.bindings;
}

const OS_LABELS: Record<ShortcutOS, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

/**
 * A shortcut's bindings as text for a reference that serves every system (the docs): `Cmd+P or
 * Ctrl+P` style text.
 */
export function formatShortcutDefinitionText(shortcut: Pick<ShortcutDefinition, 'bindings' | 'platformBindings'>): string {
  if (!shortcut.platformBindings) return formatShortcutBindingsText(shortcut.bindings);
  return (['mac', 'windows', 'linux'] as const)
    .map((os) => `${formatShortcutBindingsText(resolveShortcutBindings(shortcut, os), os === 'mac' ? 'mac' : 'non-mac')} (${OS_LABELS[os]})`)
    .join(' · ');
}

function formatKeycapToken(token: string, platform: Exclude<ShortcutPlatform, 'cross-platform'>): string {
  if (platform === 'mac') {
    if (token === 'Mod') return '⌘';
    if (token === 'Ctrl') return '⌃';
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

  if (token === 'Ctrl') return 'Ctrl';
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

function getDigitCode(event: ShortcutKeyEvent): string | null {
  const code = typeof event.code === 'string' ? event.code : '';
  const match = code.match(/^Digit([0-9])$/);
  return match ? match[1] : null;
}

export function getShortcutDigit(event: ShortcutKeyEvent): number | null {
  const parsed = Number.parseInt(event.key, 10);
  if (!Number.isNaN(parsed)) return parsed;

  const digitCode = getDigitCode(event);
  return digitCode === null ? null : Number.parseInt(digitCode, 10);
}

function matchesKeyToken(event: ShortcutKeyEvent, token: string, options?: ShortcutMatchOptions): boolean {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const shortcutDigit = getShortcutDigit(event);

  if (token === 'Space') {
    return event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space';
  }

  if (token === '-') {
    return event.code === 'Minus' || event.key === '-' || event.key === '_';
  }

  if (token === 'A-Z') {
    return /^[A-Z]$/.test(key);
  }

  if (token === '1-0') {
    return /^[0-9]$/.test(key) || shortcutDigit !== null;
  }

  if (isSingleLetter(token)) {
    if (key === token) return true;
    // Only a single letter outside A–Z counts: punctuation (Dvorak's `.` on KeyE, Hebrew's `/` on
    // KeyQ), a dead key or an unidentified one never turns into a letter.
    const typed = event.key;
    return options?.lettersByCode === true && typed.length === 1 && /\p{L}/u.test(typed) && !/^[A-Za-z]$/.test(typed) && event.code === `Key${token}`;
  }

  if (isSingleDigit(token)) {
    return key === token || String(shortcutDigit ?? '') === token;
  }

  return key === token;
}

/**
 * Sequential and hold bindings deliberately return false; their timing semantics are handled by
 * the shortcut runtime's dedicated paths.
 */
export function matchesShortcutBinding(event: ShortcutKeyEvent, binding: string, options?: ShortcutMatchOptions): boolean {
  if (binding.includes(' ') || binding.includes('hold')) {
    return false;
  }

  const tokens = binding.split('+').filter(Boolean);
  if (tokens.length === 0) return false;

  const requiresMod = tokens.includes('Mod');
  const requiresCtrl = tokens.includes('Ctrl');
  const requiresShift = tokens.includes('Shift');
  const requiresAlt = tokens.includes('Alt');
  const keyTokens = tokens.filter(token => !MODIFIER_TOKENS.has(token));
  if (keyTokens.length !== 1) return false;

  const keyToken = keyTokens[0];
  const shiftMatches = requiresShift === event.shiftKey
    || (!requiresShift && keyToken === 'A-Z' && event.shiftKey)
    || (!requiresShift && SHIFTED_LITERAL_TOKENS.has(keyToken) && event.key === keyToken);

  if (requiresMod) {
    if (!(event.metaKey || event.ctrlKey)) return false;
  } else if (requiresCtrl) {
    if (!event.ctrlKey || event.metaKey) return false;
  } else if (event.metaKey || event.ctrlKey) {
    return false;
  }
  if (!shiftMatches) return false;
  if (requiresAlt !== event.altKey) return false;

  return matchesKeyToken(event, keyToken, options);
}

export function matchesShortcutBindingGroup(event: ShortcutKeyEvent, group: string, options?: ShortcutMatchOptions): boolean {
  return matchesShortcutBinding(event, group, options);
}

export function getMatchingShortcutBindingIndex(event: ShortcutKeyEvent, bindings: string[]): number {
  return bindings.findIndex(binding => matchesShortcutBinding(event, binding));
}
