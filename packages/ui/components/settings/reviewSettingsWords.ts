/**
 * Every word on Settings → Reviews (`ReviewSettingsPage`): section titles,
 * row labels and hints, the option lists, and the Power Up form's messages.
 * One module so a host (classic code review today, the Inbox next) draws the
 * same words. The rows the diff gear also draws take their names from
 * `../diffDisplayModel.ts`, and their option lists from
 * `DiffDisplayOptions.tsx`, so the gear and this page can never disagree.
 *
 * Importable from other packages as
 * `@plannotator/ui/components/settings/reviewSettingsWords`.
 */
import { modKeyWord } from '../../utils/platform';
import { DIFF_DISPLAY_LABELS } from '../diffDisplayModel';

export const REVIEW_SETTINGS_TAB_LABEL = 'Reviews';

export const SECTION_WORDS = {
  display: {
    title: 'Diff display',
    description: 'The same choices as the gear above the diff.',
    compactDescription: 'This layout shows unified diffs for the session; your desktop preference is unchanged.',
  },
  /** The heading of the standalone `SemanticDiffsTab` (the page's section is the Semantic changes switch). */
  semantic: {
    title: 'Semantic diffs',
    description: 'Labels what each change really is: moved, renamed, reformatted, extracted.',
  },
  callFlow: {
    description: 'Diffs for function call stacks across git commits. 22 languages supported (AST-based, built using Tree-sitter).',
    note: 'Call flow is syntactic. It does not use type resolution or runtime traces, so treat it as navigation context—not proof that a path executes.',
  },
  packages: {
    description: 'Added, removed and changed dependencies above package.json and lockfile diffs.',
  },
  files: { title: 'Files and defaults' },
} as const;

export const DISPLAY_WORDS = {
  layout: 'Split or Unified',
  layoutOptions: [
    { value: 'split' as const, label: 'Split' },
    { value: 'unified' as const, label: 'Unified' },
  ],
  wrap: DIFF_DISPLAY_LABELS.wrap,
  lineNumbers: DIFF_DISPLAY_LABELS.lineNumbers,
  backgrounds: DIFF_DISPLAY_LABELS.backgrounds,
  backgroundStrength: DIFF_DISPLAY_LABELS.backgroundStrength,
  minimap: DIFF_DISPLAY_LABELS.minimap,
  changeMarks: DIFF_DISPLAY_LABELS.changeMarks,
  changedWords: DIFF_DISPLAY_LABELS.changedWords,
  tabSize: DIFF_DISPLAY_LABELS.tabSize,
  decreaseTabSize: DIFF_DISPLAY_LABELS.decreaseTabSize,
  increaseTabSize: DIFF_DISPLAY_LABELS.increaseTabSize,
  wholeFile: DIFF_DISPLAY_LABELS.wholeFile,
  hideWhitespace: DIFF_DISPLAY_LABELS.hideWhitespace,
} as const;

export const FONT_WORDS = {
  label: 'Code Font',
  description: 'Font family for diff code lines',
  previewText: 'Preview: const x = fn(42);',
  customAriaLabel: 'Custom code font name',
  customPlaceholder: 'Font name as installed, e.g. Iosevka',
  notFoundText: 'Not found — diffs will fall back to monospace',
  sizeLabel: 'Code Font Size',
  sizeDescription: 'Font size for diff code lines',
  sizeAuto: 'Auto',
  sizeReset: 'Reset',
} as const;

export const DIFF_FONT_OPTIONS = [
  { value: '', label: 'Theme Default' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Hack', label: 'Hack' },
  { value: 'IBM Plex Mono', label: 'IBM Plex Mono' },
  { value: 'Inconsolata', label: 'Inconsolata' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Red Hat Mono', label: 'Red Hat Mono' },
  { value: 'Roboto Mono', label: 'Roboto Mono' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'Atkinson Hyperlegible Mono', label: 'Atkinson Hyperlegible' },
];

export const HOVER_WORDS = {
  label: 'Hover cards',
  description: `Rest the pointer on a symbol in a diff to see where it is defined and who references it. Needs ripgrep and a local checkout; nothing appears when the search comes back empty. ${modKeyWord}+click still opens the References panel either way.`,
  delay: 'How long the pointer rests before a card is requested',
} as const;

/**
 * The modifier gate is the platform's primary modifier: Cmd on macOS, Ctrl on
 * Windows and Linux. Labeled through modKeyWord so the control names the key
 * the reader actually has.
 */
export const TOKEN_HOVER_TRIGGER_OPTIONS = [
  { value: 'hover' as const, label: 'On hover' },
  { value: 'modifier' as const, label: `Hold ${modKeyWord}` },
  { value: 'off' as const, label: 'Off' },
];
/** SegmentedControl keys on strings, so the ms values ride as their digits. */
export type TokenHoverDelayOption = '150' | '300' | '700';
export const TOKEN_HOVER_DELAY_OPTIONS = [
  { value: '150' as const, label: 'Fast' },
  { value: '300' as const, label: 'Default' },
  { value: '700' as const, label: 'Relaxed' },
];

export const SEMANTIC_WORDS = {
  master: 'Semantic changes',
  masterDescription: 'Organize added, changed, moved, and removed functions, classes, and other named code. Enabled by default.',
  moved: DIFF_DISPLAY_LABELS.moved,
  movedDescription: 'Draw moved, renamed, reformatted, extracted and inlined code as what it is.',
  /** Under Show moved & renamed code and Power Up while the master switch is off: they stay, greyed. */
  offWhileMasterOff: 'Off while Semantic changes is off.',
} as const;

export const CALL_FLOW_WORDS = { label: 'Call flow' } as const;

export const PACKAGE_WORDS = {
  card: 'Package changes',
  lookup: 'Look up packages on npm',
  lookupDescription: 'License, release date and weekly downloads. Sends the names of changed public packages to registry.npmjs.org and api.npmjs.org.',
  lookupEnvOff: 'Off: PLANNOTATOR_PACKAGE_LOOKUP=0.',
} as const;

export const FILES_WORDS = {
  autoViewed: 'Auto-mark viewed',
  autoViewedDescription: 'Mark a file viewed when you scroll past it or move on to another file. Files you un-view stay un-viewed, and files that change on refresh become un-viewed.',
  git: 'Git',
  jj: 'Jujutsu',
  grouping: 'Default file grouping',
  groupingDescription: "How the file tree groups a code review's files when it opens",
  groupingUnavailable: "Grouping by git status isn't available in this repository (its base branch couldn't be resolved), so reviews here open grouped by kind. The preference still applies in repositories where it works.",
  groupingOptions: [
    { value: 'sections' as const, label: 'By git status' },
    { value: 'tree' as const, label: 'By kind' },
  ],
  diffView: 'Default diff view',
  diffViewDescription: 'Which changes to show when you open a code review',
  jjDiffViewDescription: 'Which changes to show when you open a review in a Jujutsu repository',
  gitDiffViewAria: 'Default diff view (Git)',
  jjDiffViewAria: 'Default diff view (Jujutsu)',
} as const;

export const DEFAULT_DIFF_TYPE_OPTIONS = [
  // "All Changes" belongs to since-base (the flagship composite); uncommitted
  // reverts to its plain name so the two stay distinguishable side by side.
  { value: 'since-base' as const, label: 'All Changes (Recommended)', description: "Everything since your branch split from main — committed, uncommitted, and untracked" },
  { value: 'local-vs-remote' as const, label: 'Local vs Remote Branch', description: "Your local branch and working tree compared with its last-fetched remote-tracking branch" },
  { value: 'uncommitted' as const, label: 'Uncommitted', description: "Everything you've changed since your last commit" },
  { value: 'unstaged' as const, label: 'Unstaged', description: "Only changes you haven't staged yet" },
  { value: 'staged' as const, label: 'Staged', description: "Only changes you've staged for commit" },
  { value: 'merge-base' as const, label: 'Committed changes (PR view)', description: "Everything you've committed on this branch" },
  { value: 'all' as const, label: 'All Files (HEAD)', description: "Every tracked file at HEAD, shown as additions" },
];
// Labels match the jj diff picker (getJjContext in packages/shared/jj-core.ts).
export const JJ_DEFAULT_DIFF_TYPE_OPTIONS = [
  { value: 'jj-current', label: 'Current change', description: 'Only the working-copy change (@)' },
  { value: 'jj-last', label: 'Last change', description: 'The change just before the working copy (@-)' },
  { value: 'jj-line', label: 'Line of work', description: 'Every change on your line of work since it left trunk' },
  { value: 'jj-evolog', label: 'Evolution diff', description: 'How the current change has evolved' },
  { value: 'jj-all', label: 'Every file', description: 'Every file at the working copy, shown as additions' },
] as const;

// --- Power Up ---------------------------------------------------------------

export const POWER_UP_PROVIDER_NAMES = { jev: 'Jev', clef: 'Clef', openai: 'OpenAI Decisions', custom: 'Custom' } as const;
export type PowerUpProvider = keyof typeof POWER_UP_PROVIDER_NAMES;
export type PowerUpFailure = 'missing' | 'invalidUrl' | 'refused' | 'noCredit' | 'noAnswer';

export const PROVIDER_SETTINGS = {
  jev: { title: 'Jev key', credential: 'a Jev key', label: 'TypeSafe API key', hint: 'Paste the key from your TypeSafe account', modelHint: 'Jev runs on your TypeSafe account.' },
  clef: { title: 'Workers AI', credential: 'a Clef token', label: 'Workers AI token', hint: 'Your Cloudflare account ID and a Workers AI token', modelHint: 'Clef runs on your Cloudflare account.' },
  openai: { title: 'OpenAI key', credential: 'an OpenAI API key', label: 'OpenAI API key', hint: 'Paste an OpenAI project API key', modelHint: 'OpenAI Decisions runs on your OpenAI API project.' },
  custom: { title: 'Custom endpoint', credential: 'a custom endpoint key', label: 'Custom API key', hint: 'Endpoint URL, optional model, auth header, and API key', modelHint: 'Your own server, if it speaks the same API as Jev.' },
} satisfies Record<PowerUpProvider, { title: string; credential: string; label: string; hint: string; modelHint: string }>;

export const POWER_UP_WORDS = {
  label: 'Power Up',
  model: 'Model',
  motion: 'Motion',
  motionDescription: "Stream moves the bands slowly. It is experimental: it costs some smoothness while you scroll. Both follow your system's reduce-motion setting.",
  motionOptions: [
    { value: 'still' as const, label: 'Still' },
    { value: 'stream' as const, label: 'Stream' },
  ],
  unavailable: 'This review host cannot keep a key.',
  envModel: (summary: string) => `${summary} · configured via environment`,
  envKey: 'Provided by PLANNOTATOR_OPINION_API_KEY',
  apiKey: 'API key',
  accountIdCaption: 'Account ID',
  accountIdLabel: 'Cloudflare account ID',
  tokenCaption: 'Token',
  endpointCaption: 'Endpoint URL',
  endpointLabel: 'Custom endpoint URL',
  modelCaption: 'Model (optional)',
  modelLabel: 'Custom model',
  authCaption: 'Auth',
  authLabel: 'Auth header',
  authOptions: [
    { value: 'bearer' as const, label: 'Bearer' },
    { value: 'api-key' as const, label: 'Api-Key' },
  ],
  remove: 'Remove',
  checking: 'Checking…',
  saved: 'Saved',
  checkAndSave: 'Check and save',
  keptHere: 'Kept on this computer',
  addAccountId: 'Add your account ID',
  addToken: 'Add your token',
  addApiKey: 'Add your API key',
  addEndpoint: 'Add an endpoint URL',
  invalidUrl: 'Enter an http or https endpoint URL',
} as const;

/** Jev and Custom speak the systemone contract, so only they go to an endpoint the person chose. */
export function takesEndpoint(provider: PowerUpProvider): boolean {
  return provider === 'jev' || provider === 'custom';
}

export function targetName(provider: PowerUpProvider, endpoint: string | null): string {
  if (takesEndpoint(provider) && endpoint) return endpoint;
  return POWER_UP_PROVIDER_NAMES[provider];
}

function footerTarget(provider: PowerUpProvider, endpoint: string | null): string {
  if (provider === 'custom' && !endpoint) return 'your custom endpoint';
  return targetName(provider, endpoint);
}

export function powerUpFooter(provider: PowerUpProvider, endpoint: string | null): string {
  return `Your key, your account; code is sent to ${footerTarget(provider, endpoint)}. Only the functions the engine asks about are sent, never the rest of the repository.`;
}

export function powerUpDescription(configured: boolean): string {
  const suffix = configured
    ? 'When it is on, every semantic diff gets that second look.'
    : 'Add a key below to turn it on.';
  return `A model takes a second look at changes the engine could not label on its own. ${suffix}`;
}

export function addKeyHint(provider: PowerUpProvider, endpoint: string | null): string {
  if (!takesEndpoint(provider) || !endpoint) return PROVIDER_SETTINGS[provider].hint;
  return provider === 'custom' ? `Key and auth for ${endpoint}` : `Paste the key for ${endpoint}`;
}

export function missingKeyText(provider: PowerUpProvider, endpoint: string | null): string {
  if (provider === 'custom' || (provider === 'jev' && endpoint)) return POWER_UP_WORDS.addApiKey;
  return `Add your ${PROVIDER_SETTINGS[provider].label}`;
}

export function failureText(provider: PowerUpProvider, failure: PowerUpFailure, endpoint: string | null): string {
  const name = targetName(provider, endpoint);
  if (failure === 'missing') return missingKeyText(provider, endpoint);
  if (failure === 'invalidUrl') return POWER_UP_WORDS.invalidUrl;
  if (failure === 'refused') return `${name} refused this ${provider === 'clef' ? 'token' : 'key'}`;
  if (failure === 'noCredit') return `No credit left on this ${name} account`;
  return `${name} did not answer. Try again in a moment.`;
}

export function customTargetSummary(endpoint: string | null, model: string | null): string | null {
  if (!endpoint && !model) return null;
  const host = endpoint ?? 'Jev';
  return model ? `${host} · ${model}` : host;
}

export function nextKeyLabel(provider: PowerUpProvider, endpoint: string | null): string {
  if (takesEndpoint(provider) && endpoint) return `a key for ${endpoint}`;
  return PROVIDER_SETTINGS[provider].credential;
}

export function providerDefaultHint(provider: PowerUpProvider, endpoint: string | null, model: string | null): string {
  const fallback = PROVIDER_SETTINGS[provider].modelHint;
  if (!takesEndpoint(provider)) return fallback;
  return customTargetSummary(endpoint, model) ?? fallback;
}

export function keepsPoweringUp(active: string, provider: PowerUpProvider, endpoint: string | null): string {
  return `${active} keeps powering up until ${nextKeyLabel(provider, endpoint)} works.`;
}

export function keyWorks(ms: number): string {
  return `✓ Key works · ${ms} ms`;
}

export function saveButtonLabel(checking: boolean, saved: boolean, complete: boolean): string {
  if (checking) return POWER_UP_WORDS.checking;
  return saved && !complete ? POWER_UP_WORDS.saved : POWER_UP_WORDS.checkAndSave;
}

export function rowTitle(provider: PowerUpProvider, endpoint: string | null): string {
  if (provider === 'jev' && endpoint) return POWER_UP_WORDS.apiKey;
  return PROVIDER_SETTINGS[provider].title;
}
