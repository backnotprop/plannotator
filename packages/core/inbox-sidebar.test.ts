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
  inboxSidebarStep,
  inboxSidebarToStack,
  type InboxSidebarItem,
  type InboxSidebarLayout,
} from './inbox-sidebar';

const D = INBOX_SIDEBAR_DEFAULT;
const layout = (top: InboxSidebarItem[], bottom: InboxSidebarItem[], hidden: InboxSidebarItem[] = []): InboxSidebarLayout => ({ top, bottom, hidden });

test('the default is today\'s sidebar: Search to Drafts at the top, Copy prompt to Settings at the bottom, nothing hidden', () => {
  expect(D).toEqual(layout(['search', 'new-message', 'inbox', 'board', 'shape', 'reviews', 'artifacts', 'drafts'], ['copy-prompt', 'feedback', 'usage', 'settings']));
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
      { top: ['inbox', 'later-item', 'search', 'new-message', 'board', 'shape', 'reviews', 'artifacts', 'drafts'], bottom: ['settings', 'copy-prompt', 'feedback', 'usage', 'bogus'], hidden: ['later-item', 'feedback'] },
      layout(['inbox', 'search', 'new-message', 'board', 'shape', 'reviews', 'artifacts', 'drafts'], ['settings', 'copy-prompt', 'feedback', 'usage'], ['feedback']),
    ],
    [
      'an item named twice counts once, where it first appears',
      { top: ['search', 'new-message', 'inbox', 'board', 'shape', 'reviews', 'artifacts', 'drafts', 'feedback'], bottom: ['copy-prompt', 'feedback', 'usage', 'settings'], hidden: [] },
      layout(['search', 'new-message', 'inbox', 'board', 'shape', 'reviews', 'artifacts', 'drafts', 'feedback'], ['copy-prompt', 'usage', 'settings']),
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
      layout(['reviews', 'artifacts', 'inbox', 'search', 'new-message', 'board', 'shape', 'drafts'], ['settings', 'copy-prompt', 'feedback', 'usage']),
    ],
    [
      'a missing item whose default neighbours all moved to the other stack goes before the next one that stayed, else last',
      { top: ['inbox', 'drafts'], bottom: ['search', 'new-message', 'board', 'reviews', 'copy-prompt', 'feedback', 'usage', 'settings'], hidden: [] },
      layout(['inbox', 'shape', 'artifacts', 'drafts'], ['search', 'new-message', 'board', 'reviews', 'copy-prompt', 'feedback', 'usage', 'settings']),
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
  const noBoard = (item: InboxSidebarItem) => item !== 'board' && item !== 'shape';
  const cases: [string, () => InboxSidebarLayout, InboxSidebarItem[], InboxSidebarItem[]][] = [
    ['Move up', () => inboxSidebarStep(D, 'reviews', -1), ['search', 'new-message', 'inbox', 'board', 'reviews', 'shape', 'artifacts', 'drafts'], [...D.bottom]],
    ['Move down', () => inboxSidebarStep(D, 'search', 1), ['new-message', 'search', 'inbox', 'board', 'shape', 'reviews', 'artifacts', 'drafts'], [...D.bottom]],
    ['Move up at the top of a stack does nothing', () => inboxSidebarStep(D, 'search', -1), [...D.top], [...D.bottom]],
    ['Move down at the end of a stack does nothing (Move to bottom crosses)', () => inboxSidebarStep(D, 'settings', 1), [...D.top], [...D.bottom]],
    [
      'Move up skips an item this Inbox does not draw (Board off), which keeps its place',
      () => inboxSidebarStep(D, 'reviews', -1, noBoard),
      ['search', 'new-message', 'reviews', 'inbox', 'board', 'shape', 'artifacts', 'drafts'],
      [...D.bottom],
    ],
    ['Move to bottom: the start of the bottom stack', () => inboxSidebarToStack(D, 'board', 'bottom'), ['search', 'new-message', 'inbox', 'shape', 'reviews', 'artifacts', 'drafts'], ['board', ...D.bottom]],
    ['Move to top: the end of the top stack', () => inboxSidebarToStack(D, 'settings', 'top'), [...D.top, 'settings'], ['copy-prompt', 'feedback', 'usage']],
    ['Move to top of an item already there does nothing', () => inboxSidebarToStack(D, 'inbox', 'top'), [...D.top], [...D.bottom]],
    ['a drag into the other stack at a place', () => inboxSidebarMove(D, 'search', 'bottom', 2), ['new-message', 'inbox', 'board', 'shape', 'reviews', 'artifacts', 'drafts'], ['copy-prompt', 'feedback', 'search', 'usage', 'settings']],
    ['a drag past the end lands last', () => inboxSidebarMove(D, 'inbox', 'bottom', 99), ['search', 'new-message', 'board', 'shape', 'reviews', 'artifacts', 'drafts'], [...D.bottom, 'inbox']],
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
    // Reviews and Artifacts are off: Drafts moves up past Shape (the row drawn above it), and they stay where they were.
    const next = inboxSidebarStep(D, 'drafts', -1, noReviews);
    expect(next.top).toEqual(['search', 'new-message', 'inbox', 'board', 'drafts', 'shape', 'reviews', 'artifacts']);
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
