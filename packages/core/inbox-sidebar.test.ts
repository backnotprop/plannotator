/**
 * The sidebar's layout model (approval "inbox-sidebar-customize"): what a saved layout reads as, what hides, what
 * moves, and the presets. The window's menu and panel are proved in packages/inbox/sidebarCustomize.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import {
  INBOX_SIDEBAR_DEFAULT,
  INBOX_SIDEBAR_ITEMS,
  INBOX_SIDEBAR_PRESETS,
  inboxSidebarCanStep,
  inboxSidebarCheck,
  inboxSidebarMove,
  inboxSidebarPreset,
  inboxSidebarRead,
  inboxSidebarSetShown,
  inboxSidebarMovePin,
  inboxSidebarPin,
  inboxSidebarSame,
  inboxSidebarSetRail,
  inboxSidebarStep,
  inboxSidebarToStack,
  inboxSidebarWithItems,
  type InboxSidebarItem,
  type InboxSidebarLayout,
} from './inbox-sidebar';

const D = INBOX_SIDEBAR_DEFAULT;
const layout = (top: InboxSidebarItem[], bottom: InboxSidebarItem[], hidden: InboxSidebarItem[] = []): InboxSidebarLayout => ({ top, bottom, hidden });

test('the default is today\'s sidebar: Search to Drafts at the top, Copy prompt to Settings at the bottom, nothing hidden', () => {
  expect(D).toEqual(layout(['search', 'new-message', 'inbox', 'grid', 'plans', 'board', 'scheduled', 'artifacts', 'reviews', 'drafts'], ['copy-prompt', 'feedback', 'usage', 'settings']));
  // Every stack item is in it once; the logo and the Settings row's buttons are not stack items.
  const stackItems = INBOX_SIDEBAR_ITEMS.filter((spec) => spec.place === 'stack').map((spec) => spec.id);
  expect([...D.top, ...D.bottom].sort()).toEqual([...stackItems].sort());
});

describe('reading a saved layout', () => {
  const cases: [string, unknown, InboxSidebarLayout | null][] = [
    ['nothing saved', undefined, null],
    ['not an object', 'search,inbox', null],
    ['a list', ['search'], null],
    ['an empty object: the default', {}, D],
    ['the default as saved', { top: [...D.top], bottom: [...D.bottom], hidden: [] }, D],
    [
      'a newer build\'s item and a typo are dropped; the rest keeps its order',
      { top: ['inbox', 'plans', 'later-item', 'search', 'new-message', 'board', 'scheduled', 'shape', 'reviews', 'artifacts', 'drafts'], bottom: ['settings', 'copy-prompt', 'feedback', 'usage', 'bogus'], hidden: ['later-item', 'feedback'] },
      layout(['inbox', 'grid', 'plans', 'search', 'new-message', 'board', 'scheduled', 'reviews', 'artifacts', 'drafts'], ['settings', 'copy-prompt', 'feedback', 'usage'], ['feedback']),
    ],
    [
      'a layout saved while the sidebar had a Shape row (gone) reads without it, the rest as saved',
      { top: ['inbox', 'shape', 'search', 'new-message', 'plans', 'board', 'scheduled', 'artifacts', 'reviews', 'drafts'], bottom: [...D.bottom], hidden: ['shape', 'feedback'] },
      layout(['inbox', 'grid', 'search', 'new-message', 'plans', 'board', 'scheduled', 'artifacts', 'reviews', 'drafts'], [...D.bottom], ['feedback']),
    ],
    [
      'an item named twice counts once, where it first appears',
      { top: ['search', 'new-message', 'inbox', 'plans', 'board', 'scheduled', 'shape', 'reviews', 'artifacts', 'drafts', 'feedback'], bottom: ['copy-prompt', 'feedback', 'usage', 'settings'], hidden: [] },
      layout(['search', 'new-message', 'inbox', 'grid', 'plans', 'board', 'scheduled', 'reviews', 'artifacts', 'drafts', 'feedback'], ['copy-prompt', 'usage', 'settings']),
    ],
    [
      'Inbox and Settings never read as hidden',
      { top: [...D.top], bottom: [...D.bottom], hidden: ['inbox', 'settings', 'logo'] },
      layout([...D.top], [...D.bottom], ['logo']),
    ],
    [
      'hidden reads in registry order, and names the logo and the Settings row\'s buttons',
      { top: [...D.top], bottom: [...D.bottom], hidden: ['theme', 'logo', 'shortcuts', 'board'] },
      layout([...D.top], [...D.bottom], ['logo', 'board', 'shortcuts', 'theme']),
    ],
    [
      'the logo and the Settings row\'s buttons in a stack are dropped (they do not move)',
      { top: ['logo', ...D.top], bottom: [...D.bottom, 'theme'], hidden: [] },
      D,
    ],
    [
      'an item the layout does not name (one an older build never saved) takes its default place, after its default neighbour',
      { top: ['reviews', 'inbox', 'search', 'new-message', 'board', 'drafts'], bottom: ['settings', 'copy-prompt', 'usage'], hidden: [] },
      layout(['reviews', 'inbox', 'grid', 'plans', 'search', 'new-message', 'board', 'scheduled', 'artifacts', 'drafts'], ['settings', 'copy-prompt', 'feedback', 'usage']),
    ],
    [
      'a missing item whose default neighbours all moved to the other stack goes before the next one that stayed, else last',
      { top: ['inbox', 'drafts'], bottom: ['search', 'new-message', 'board', 'reviews', 'copy-prompt', 'feedback', 'usage', 'settings'], hidden: [] },
      layout(['inbox', 'grid', 'plans', 'scheduled', 'artifacts', 'drafts'], ['search', 'new-message', 'board', 'reviews', 'copy-prompt', 'feedback', 'usage', 'settings']),
    ],
    [
      'non-strings in a list are skipped',
      { top: [1, null, ...D.top], bottom: [...D.bottom, { id: 'x' }], hidden: [true, 'feedback'] },
      layout([...D.top], [...D.bottom], ['feedback']),
    ],
  ];
  for (const [name, input, want] of cases) test(name, () => expect(inboxSidebarRead(input)).toEqual(want));
});

describe('checking a layout sent to be saved', () => {
  const cases: [string, unknown, boolean][] = [
    ['the default', { top: [...D.top], bottom: [...D.bottom], hidden: [] }, true],
    ['every item at the top', { top: [...D.top, ...D.bottom], bottom: [], hidden: [] }, true],
    ['an unknown name', { top: [...D.top, 'later-item'], bottom: [...D.bottom], hidden: [] }, false],
    ['an unknown key', { top: [...D.top], bottom: [...D.bottom], hidden: [], extra: 1 }, false],
    ['a missing list', { top: [...D.top], bottom: [...D.bottom] }, false],
    ['a non-string', { top: [...D.top, 3], bottom: [...D.bottom], hidden: [] }, false],
    ['too long a list', { top: Array(65).fill('inbox'), bottom: [], hidden: [] }, false],
    ['not an object', null, false],
  ];
  for (const [name, input, ok] of cases) test(name, () => expect(inboxSidebarCheck(input) !== null).toBe(ok));
  test('what it keeps is read leniently: a locked item sent as hidden is shown', () => {
    expect(inboxSidebarCheck({ top: [...D.top], bottom: [...D.bottom], hidden: ['inbox', 'feedback'] })).toEqual(layout([...D.top], [...D.bottom], ['feedback']));
  });
});

describe('Agents: a section between the stacks that hides and never moves', () => {
  test('it is not a stack item, and the default shows it', () => {
    expect([...D.top, ...D.bottom]).not.toContain('agents');
    expect(D.hidden).toEqual([]);
  });
  test('a layout saved before Agents was an item reads as shown', () => {
    const old = { top: [...D.top], bottom: [...D.bottom], hidden: ['feedback'] };
    expect(inboxSidebarRead(old)!.hidden).toEqual(['feedback']);
  });
  test('it hides and shows, is saved in hidden, and passes the strict write check', () => {
    const hidden = inboxSidebarSetShown(D, 'agents', false);
    expect(hidden).toEqual(layout([...D.top], [...D.bottom], ['agents']));
    expect(inboxSidebarCheck(hidden)).toEqual(hidden);
    expect(inboxSidebarRead(JSON.parse(JSON.stringify(hidden)))).toEqual(hidden);
    expect(inboxSidebarSetShown(hidden, 'agents', true)).toEqual(D);
  });
  test('named in a stack it is dropped; a move changes nothing', () => {
    expect(inboxSidebarRead({ top: ['agents', ...D.top], bottom: [...D.bottom], hidden: [] })).toEqual(D);
    expect(inboxSidebarMove(D, 'agents', 'top', 0)).toEqual(D);
    expect(inboxSidebarToStack(D, 'agents', 'bottom')).toEqual(D);
  });
  test('no preset hides it', () => {
    for (const preset of ['default', 'all-top', 'minimal'] as const) expect(INBOX_SIDEBAR_PRESETS[preset].layout.hidden).not.toContain('agents');
  });
});

describe('Starred and Projects: sections between the stacks that hide and never move', () => {
  for (const id of ['starred', 'projects'] as const) {
    test(`${id}: shown by default and by a layout saved before it was an item; hides, saves, never moves; no preset hides it`, () => {
      expect([...D.top, ...D.bottom]).not.toContain(id);
      expect(inboxSidebarRead({ top: [...D.top], bottom: [...D.bottom], hidden: ['feedback'] })!.hidden).not.toContain(id);
      const hidden = inboxSidebarSetShown(D, id, false);
      expect(hidden).toEqual(layout([...D.top], [...D.bottom], [id]));
      expect(inboxSidebarCheck(hidden)).toEqual(hidden);
      expect(inboxSidebarSetShown(hidden, id, true)).toEqual(D);
      expect(inboxSidebarRead({ top: [id, ...D.top], bottom: [...D.bottom], hidden: [] })).toEqual(D);
      expect(inboxSidebarMove(D, id, 'top', 0)).toEqual(D);
      for (const preset of ['default', 'all-top', 'minimal'] as const) expect(INBOX_SIDEBAR_PRESETS[preset].layout.hidden).not.toContain(id);
    });
  }
});

describe('showing and hiding', () => {
  const cases: [string, InboxSidebarItem, boolean, InboxSidebarItem[]][] = [
    ['Feedback hides', 'feedback', false, ['feedback']],
    ['the logo hides', 'logo', false, ['logo']],
    ['Copy prompt hides', 'copy-prompt', false, ['copy-prompt']],
    ['the keyboard button hides', 'shortcuts', false, ['shortcuts']],
    ['Settings never hides', 'settings', false, []],
    ['Inbox never hides', 'inbox', false, []],
  ];
  for (const [name, item, shown, hidden] of cases) test(name, () => expect(inboxSidebarSetShown(D, item, shown).hidden).toEqual(hidden));
  test('showing again takes it out of hidden; the order of the rest stays', () => {
    const hidden = inboxSidebarSetShown(inboxSidebarSetShown(inboxSidebarSetShown(D, 'theme', false), 'logo', false), 'board', false);
    expect(hidden.hidden).toEqual(['logo', 'board', 'theme']);
    expect(inboxSidebarSetShown(hidden, 'board', true).hidden).toEqual(['logo', 'theme']);
  });
  test('hiding never moves an item', () => {
    const hidden = inboxSidebarSetShown(D, 'board', false);
    expect(hidden.top).toEqual(D.top);
    expect(hidden.bottom).toEqual(D.bottom);
  });
});

describe('moving', () => {
  const noBoard = (item: InboxSidebarItem) => item !== 'grid' && item !== 'plans' && item !== 'board' && item !== 'scheduled';
  const cases: [string, () => InboxSidebarLayout, InboxSidebarItem[], InboxSidebarItem[]][] = [
    ['Move up', () => inboxSidebarStep(D, 'reviews', -1), ['search', 'new-message', 'inbox', 'grid', 'plans', 'board', 'scheduled', 'reviews', 'artifacts', 'drafts'], [...D.bottom]],
    ['Move down', () => inboxSidebarStep(D, 'search', 1), ['new-message', 'search', 'inbox', 'grid', 'plans', 'board', 'scheduled', 'artifacts', 'reviews', 'drafts'], [...D.bottom]],
    ['Move up at the top of a stack does nothing', () => inboxSidebarStep(D, 'search', -1), [...D.top], [...D.bottom]],
    ['Move down at the end of a stack does nothing (Move to bottom crosses)', () => inboxSidebarStep(D, 'settings', 1), [...D.top], [...D.bottom]],
    [
      'Move up skips an item this Inbox does not draw (Board off), which keeps its place',
      () => inboxSidebarStep(D, 'artifacts', -1, noBoard),
      ['search', 'new-message', 'artifacts', 'inbox', 'grid', 'plans', 'board', 'scheduled', 'reviews', 'drafts'],
      [...D.bottom],
    ],
    ['Move to bottom: the start of the bottom stack', () => inboxSidebarToStack(D, 'board', 'bottom'), ['search', 'new-message', 'inbox', 'grid', 'plans', 'scheduled', 'artifacts', 'reviews', 'drafts'], ['board', ...D.bottom]],
    ['Move to top: the end of the top stack', () => inboxSidebarToStack(D, 'settings', 'top'), [...D.top, 'settings'], ['copy-prompt', 'feedback', 'usage']],
    ['Move to top of an item already there does nothing', () => inboxSidebarToStack(D, 'inbox', 'top'), [...D.top], [...D.bottom]],
    ['a drag into the other stack at a place', () => inboxSidebarMove(D, 'search', 'bottom', 2), ['new-message', 'inbox', 'grid', 'plans', 'board', 'scheduled', 'artifacts', 'reviews', 'drafts'], ['copy-prompt', 'feedback', 'search', 'usage', 'settings']],
    ['a drag past the end lands last', () => inboxSidebarMove(D, 'inbox', 'bottom', 99), ['search', 'new-message', 'grid', 'plans', 'board', 'scheduled', 'artifacts', 'reviews', 'drafts'], [...D.bottom, 'inbox']],
    ['the logo never moves', () => inboxSidebarMove(D, 'logo', 'bottom', 0), [...D.top], [...D.bottom]],
    ['the Settings row\'s buttons never move', () => inboxSidebarToStack(D, 'theme', 'top'), [...D.top], [...D.bottom]],
  ];
  for (const [name, run, top, bottom] of cases) {
    test(name, () => {
      const next = run();
      expect(next.top).toEqual(top);
      expect(next.bottom).toEqual(bottom);
    });
  }
  test('an item turned off by a capability keeps its place through other moves, and is there when it comes back', () => {
    const noReviews = (item: InboxSidebarItem) => item !== 'reviews' && item !== 'artifacts';
    // Artifacts and Reviews are off: Drafts moves up past Routines (the row drawn above it), and they stay where they were.
    const next = inboxSidebarStep(D, 'drafts', -1, noReviews);
    expect(next.top).toEqual(['search', 'new-message', 'inbox', 'grid', 'plans', 'board', 'drafts', 'scheduled', 'artifacts', 'reviews']);
    expect(inboxSidebarRead(next)).toEqual(next);
  });
  test('Move up / Move down say when they have nowhere to go', () => {
    expect(inboxSidebarCanStep(D, 'search', -1)).toBe(false);
    expect(inboxSidebarCanStep(D, 'search', 1)).toBe(true);
    expect(inboxSidebarCanStep(D, 'settings', 1)).toBe(false);
  });
});

describe('presets', () => {
  test('each preset reads as itself; a change reads as Custom (null)', () => {
    for (const preset of ['default', 'all-top', 'minimal'] as const) expect(inboxSidebarPreset(INBOX_SIDEBAR_PRESETS[preset].layout)).toBe(preset);
    expect(inboxSidebarPreset(inboxSidebarSetShown(D, 'feedback', false))).toBeNull();
  });
  test('All at top: every stack item at the top in the default order, the bottom empty', () => {
    expect(INBOX_SIDEBAR_PRESETS['all-top'].layout).toEqual(layout([...D.top, ...D.bottom], []));
  });
  test('Minimal keeps Inbox and Settings and every capability row, and hides the rest of the extras', () => {
    const minimal = INBOX_SIDEBAR_PRESETS.minimal.layout;
    expect(minimal.hidden).toEqual(['new-message', 'copy-prompt', 'feedback', 'usage', 'shortcuts']);
    expect(inboxSidebarRead(minimal)).toEqual(minimal);
  });
});

describe('the project rail (take R1): the choice and the pins ride on the layout', () => {
  const harbor = 'project:prj_harbor';
  const fern = 'project:prj_fern';
  const release = 'tag:ini_release';
  test('off and unpinned by default: a layout that never turned it on is today\'s, field for field', () => {
    expect(D.rail).toBeUndefined();
    expect(D.pins).toBeUndefined();
    expect(inboxSidebarRead({ top: [...D.top], bottom: [...D.bottom], hidden: [] })).toEqual(D);
    // Turned on and off again with nothing pinned: the default again.
    expect(inboxSidebarSame(inboxSidebarSetRail(inboxSidebarSetRail(D, true), false), D)).toBe(true);
  });
  test('a saved rail and its pins read back in order; junk pins, repeats and a non-boolean rail are dropped', () => {
    const read = inboxSidebarRead({ top: [...D.top], bottom: [...D.bottom], hidden: [], rail: true, pins: [fern, 'nope', harbor, fern, 7, release, 'tag:'] });
    expect(read?.rail).toBe(true);
    expect(read?.pins).toEqual([fern, harbor, release]);
    expect(inboxSidebarRead({ rail: 'yes' })?.rail).toBeUndefined();
  });
  test('a save is checked strictly: a rail that is not a boolean, or a pin that is not a place, is refused', () => {
    const base = { top: [...D.top], bottom: [...D.bottom], hidden: [] };
    expect(inboxSidebarCheck({ ...base, rail: true, pins: [harbor, release] })).toEqual({ ...D, rail: true, pins: [harbor, release] });
    expect(inboxSidebarCheck({ ...base, rail: 1 })).toBeNull();
    expect(inboxSidebarCheck({ ...base, pins: ['harbor'] })).toBeNull();
    expect(inboxSidebarCheck({ ...base, pins: harbor })).toBeNull();
    expect(inboxSidebarCheck({ ...base, other: true })).toBeNull();
  });
  test('pin, reorder and unpin: the rail\'s order is the person\'s, and the choice stays', () => {
    const on = inboxSidebarSetRail(D, true);
    const pinned = inboxSidebarPin(inboxSidebarPin(inboxSidebarPin(on, harbor, true), fern, true), release, true);
    expect(pinned.pins).toEqual([harbor, fern, release]);
    expect(inboxSidebarPin(pinned, harbor, true).pins).toEqual([fern, release, harbor]);
    expect(inboxSidebarMovePin(pinned, release, 0).pins).toEqual([release, harbor, fern]);
    expect(inboxSidebarMovePin(pinned, harbor, 99).pins).toEqual([fern, release, harbor]);
    const unpinned = inboxSidebarPin(pinned, fern, false);
    expect(unpinned.pins).toEqual([harbor, release]);
    expect(unpinned.rail).toBe(true);
    expect(inboxSidebarSame(unpinned, pinned)).toBe(false);
  });
  test('turning it off keeps the pins for next time', () => {
    const off = inboxSidebarSetRail(inboxSidebarPin(inboxSidebarSetRail(D, true), harbor, true), false);
    expect(off.rail).toBeUndefined();
    expect(off.pins).toEqual([harbor]);
  });
  test('a preset or Reset to default changes the items only: the rail and its pins stay, and the preset still reads as itself', () => {
    const mine = inboxSidebarPin(inboxSidebarSetRail(inboxSidebarSetShown(D, 'feedback', false), true), harbor, true);
    const reset = inboxSidebarWithItems(mine, D);
    expect(reset).toEqual({ ...D, rail: true, pins: [harbor] });
    expect(inboxSidebarPreset(reset)).toBe('default');
    expect(inboxSidebarPreset(inboxSidebarWithItems(mine, INBOX_SIDEBAR_PRESETS.minimal.layout))).toBe('minimal');
  });
});
