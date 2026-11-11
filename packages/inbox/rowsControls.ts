import { LIST_LOOK_DEFAULT, LIST_LOOK_KEYS, LIST_LOOK_OFF, lookMarks, lookWithChange, markStyleLook, marksWhatLook, type ListLook, type ListLookKey, type MarkStyle, type MarksWhat } from './listLook';

export type RowsControlId = 'spacing' | 'preview' | 'first' | 'time' | 'needs' | 'agents' | 'project' | 'pulls' | 'newer' | 'boldAll' | 'pill' | 'dividers' | 'timeAt' | 'badges' | 'shape' | 'logo' | 'github';

export type RowsControlValue = string | boolean | null;

interface ControlBase {
  id: RowsControlId;
  label: string;
  desc?: (look: ListLook) => string | undefined;
  keys: readonly ListLookKey[];
}
export interface RowsSegControl extends ControlBase {
  kind: 'seg';
  choices: readonly { id: string; label: string }[];
  get: (look: ListLook) => string | null;
  set: (value: string, look: ListLook) => Partial<ListLook>;
}
export interface RowsSwitchControl extends ControlBase {
  kind: 'switch';
  get: (look: ListLook) => boolean;
  set: (on: boolean, look: ListLook) => Partial<ListLook>;
}
export type RowsControl = RowsSegControl | RowsSwitchControl;

const seg = (control: Omit<RowsSegControl, 'kind'>): RowsSegControl => ({ kind: 'seg', ...control });
const onSwitch = (id: RowsControlId, key: ListLookKey, label: string, desc?: string): RowsSwitchControl => ({ kind: 'switch', id, label, keys: [key], desc: desc ? () => desc : undefined, get: (look) => look[key], set: (on) => ({ [key]: on }) });
const showSwitch = (id: RowsControlId, key: ListLookKey, label: string, desc?: string): RowsSwitchControl => ({ kind: 'switch', id, label, keys: [key], desc: desc ? () => desc : undefined, get: (look) => !look[key], set: (on) => ({ [key]: !on }) });

export const ROWS_MAIN_CONTROLS: readonly RowsControl[] = [
  seg({
    id: 'spacing',
    label: 'Spacing',
    keys: ['compact', 'roomy'],
    desc: (look) => (look.compact ? 'Project and name share the first line' : undefined),
    choices: [
      { id: 'compact', label: 'Compact' },
      { id: 'comfortable', label: 'Comfortable' },
      { id: 'roomy', label: 'Roomy' },
    ],
    get: (look) => (look.compact ? 'compact' : look.roomy ? 'roomy' : 'comfortable'),
    set: (value) => ({ compact: value === 'compact', roomy: value === 'roomy' }),
  }),
  seg({
    id: 'preview',
    label: 'Grey line under the name',
    keys: ['hidePreview', 'previewTwo'],
    choices: [
      { id: 'none', label: 'None' },
      { id: 'one', label: '1 line' },
      { id: 'two', label: '2 lines' },
    ],
    get: (look) => (look.hidePreview ? 'none' : look.previewTwo ? 'two' : 'one'),
    set: (value) => ({ hidePreview: value === 'none', previewTwo: value === 'two' }),
  }),
  seg({
    id: 'first',
    label: 'First on the row',
    keys: ['titleFirst'],
    choices: [
      { id: 'project', label: 'Project' },
      { id: 'name', label: 'Thread name' },
    ],
    get: (look) => (look.titleFirst ? 'name' : 'project'),
    set: (value) => ({ titleFirst: value === 'name' }),
  }),
  seg({
    id: 'time',
    label: 'Time',
    keys: ['relativeTime'],
    choices: [
      { id: 'clock', label: '9:12 PM' },
      { id: 'relative', label: '10m ago' },
    ],
    get: (look) => (look.relativeTime ? 'relative' : 'clock'),
    set: (value) => ({ relativeTime: value === 'relative' }),
  }),
  seg({
    id: 'needs',
    label: 'When a thread needs you',
    keys: ['statusMark'],
    choices: [
      { id: 'count', label: 'Question count' },
      { id: 'mark', label: 'One mark' },
    ],
    get: (look) => (look.statusMark ? 'mark' : 'count'),
    set: (value) => ({ statusMark: value === 'mark' }),
  }),
  showSwitch('agents', 'hideAgents', 'Agent icons'),
  showSwitch('project', 'hideProject', 'Project name'),
  showSwitch('pulls', 'hidePulls', 'Pull requests', 'Their state at the end of the row'),
];

export const ROWS_MORE_CONTROLS: readonly RowsControl[] = [
  seg({
    id: 'newer',
    label: 'New threads',
    keys: ['smallNames', 'unreadDot'],
    choices: [
      { id: 'larger', label: 'Bigger name' },
      { id: 'bold', label: 'Bold name' },
      { id: 'dot', label: 'Dot' },
    ],
    get: (look) => (look.unreadDot ? 'dot' : look.smallNames ? 'bold' : 'larger'),
    set: (value) => ({ smallNames: value !== 'larger', unreadDot: value === 'dot' }),
  }),
  onSwitch('boldAll', 'boldNames', 'Every thread name in bold', 'Read ones too'),
  onSwitch('pill', 'highlight', 'Thread name in a grey pill'),
  onSwitch('dividers', 'dividers', 'Lines between rows'),
  seg({
    id: 'timeAt',
    label: 'Where the time sits',
    keys: ['timeBelow'],
    desc: (look) => (look.compact ? 'Only on rows that are not Compact' : undefined),
    choices: [
      { id: 'top', label: 'Top right' },
      { id: 'below', label: 'Under the row' },
    ],
    get: (look) => (look.timeBelow ? 'below' : 'top'),
    set: (value) => ({ timeBelow: value === 'below' }),
  }),
  seg({
    id: 'badges',
    label: 'Letter badges',
    keys: ['marksThreads', 'marksProjects'],
    choices: [
      { id: 'off', label: 'Off' },
      { id: 'threads', label: 'Threads' },
      { id: 'projects', label: 'Projects' },
      { id: 'both', label: 'Both' },
    ],
    get: (look) => lookMarks(look).what,
    set: (value) => marksWhatLook(value as MarksWhat),
  }),
  seg({
    id: 'shape',
    label: 'Badge shape',
    keys: ['markInline', 'markDot'],
    desc: (look) => (lookMarks(look).what === 'off' ? 'Picking one turns thread badges on' : undefined),
    choices: [
      { id: 'avatar', label: 'Big, at the left' },
      { id: 'inline', label: 'Small, in the line' },
      { id: 'dot', label: 'A dot' },
    ],
    get: (look) => (lookMarks(look).what === 'off' ? null : lookMarks(look).style),
    set: (value, look) => markStyleLook(value as MarkStyle, look),
  }),
  onSwitch('logo', 'repoLogo', 'Repo logo on project badges', 'Stays on this computer'),
  onSwitch('github', 'githubPictures', 'GitHub pictures on project badges', 'Asks GitHub once a week'),
];

export const ROWS_CONTROLS: readonly RowsControl[] = [...ROWS_MAIN_CONTROLS, ...ROWS_MORE_CONTROLS];

export function lookWithChoice(look: ListLook, control: RowsControl, value: string | boolean): ListLook {
  return lookWithChange(look, control.kind === 'switch' ? control.set(value === true, look) : control.set(String(value), look));
}

export function rowsControlValues(look: ListLook): Record<RowsControlId, RowsControlValue> {
  return Object.fromEntries(ROWS_CONTROLS.map((control) => [control.id, control.get(look)])) as Record<RowsControlId, RowsControlValue>;
}

export function lookFromControlValues(values: Readonly<Record<RowsControlId, RowsControlValue>>): ListLook {
  let look = LIST_LOOK_OFF;
  for (const control of ROWS_CONTROLS) {
    const value = values[control.id];
    if (value !== null) look = lookWithChoice(look, control, value);
  }
  return look;
}

export type RowsPreset = 'balanced' | 'dense' | 'minimal' | 'detailed';

export const ROWS_PRESETS: readonly { id: RowsPreset; label: string; look: ListLook }[] = [
  { id: 'balanced', label: 'Balanced', look: LIST_LOOK_DEFAULT },
  { id: 'dense', label: 'Dense', look: { ...LIST_LOOK_OFF, compact: true, smallNames: true, relativeTime: true, dividers: true, statusMark: true } },
  { id: 'minimal', label: 'Minimal', look: { ...LIST_LOOK_OFF, titleFirst: true, hidePreview: true, smallNames: true } },
  { id: 'detailed', label: 'Detailed', look: { ...LIST_LOOK_OFF, roomy: true, previewTwo: true, marksThreads: true, marksProjects: true, repoLogo: true } },
];

export function rowsPreset(look: ListLook): RowsPreset | null {
  return ROWS_PRESETS.find((preset) => LIST_LOOK_KEYS.every((key) => preset.look[key] === look[key]))?.id ?? null;
}

function valueWords(control: RowsControl, look: ListLook): string {
  if (control.kind === 'switch') return control.get(look) ? 'on' : 'off';
  const value = control.get(look);
  return control.choices.find((choice) => choice.id === value)?.label ?? 'off';
}

export function rowsChangedControls(before: ListLook, after: ListLook): RowsControl[] {
  return ROWS_CONTROLS.filter((control) => control.get(before) !== control.get(after));
}

export function rowsChangeWords(before: ListLook, after: ListLook): string[] {
  return rowsChangedControls(before, after).map((control) => `${control.label} → ${valueWords(control, after)}`);
}
