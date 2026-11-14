/**
 * The Launch tip's window rules (approval "launch-tip"; launchTip.ts). What regresses: + on a project row, a draft, a
 * Message <host>, a Board card, a pull request's hand-off, the review box or a failed clone counted as a plain New
 * message (each would use the tip up); a guest's page offered it; Beside drawn over the list where the window has no
 * room for it (it must fall back under To below about 1320 px), or beside the box on a phone.
 */
import { describe, expect, test } from 'bun:test';
import { LAUNCH_TIP_WIDTH, launchTipDue, launchTipPlace, launchTipPlainOpen } from './launchTip';

describe('launchTipPlainOpen', () => {
  test('the pencil, the list header, the Drafts page and the palette open New message with nothing in it', () => {
    expect(launchTipPlainOpen({})).toBe(true);
    expect(launchTipPlainOpen({ draft: null, session: null, body: '' })).toBe(true);
  });
  test('every other way in is not plain', () => {
    const notPlain = [
      { start: { projectId: 'prj_1', machine: null, agent: null } },
      { draft: { id: 'drf_1', body: 'x' } },
      { session: 'ses_1' },
      { card: { id: 'crd_1', title: 'Totals' } },
      { pulls: { keys: ['k'], projects: ['prj_1'] } },
      { review: {} },
      { clone: { url: 'https://github.com/acme/api', agent: 'claude-code', machine: null } },
      { body: 'The tour asks this.' },
      { threadName: 'totals' },
    ];
    for (const request of notPlain) expect(launchTipPlainOpen(request)).toBe(false);
  });
});

describe('launchTipDue', () => {
  test("the owner's page on an Inbox that reports it; never a guest's, never an older Inbox's", () => {
    expect(launchTipDue({ reveal: { next: null, launch_tip: true } })).toBe(true);
    expect(launchTipDue({ guest: false, reveal: { next: null, launch_tip: true } })).toBe(true);
    expect(launchTipDue({ guest: true, reveal: { next: null, launch_tip: true } })).toBe(false);
    expect(launchTipDue({ reveal: { next: null, launch_tip: false } })).toBe(false);
    expect(launchTipDue({ reveal: { next: null } })).toBe(false);
    expect(launchTipDue({})).toBe(false);
    expect(launchTipDue(null)).toBe(false);
  });
});

describe('launchTipPlace (the tour rule for To: right, then below)', () => {
  // Compose's box: 680 px, centred, 12vh from the top. To's row is its first row; the chip sits 72 px in.
  const at = (vw: number) => {
    const left = (vw - 680) / 2;
    const dialog = { left, right: left + 680, top: 100, bottom: 400, width: 680, height: 300 };
    const row = { left, right: left + 680, top: 100, bottom: 148, width: 680, height: 48 };
    const to = { left: left + 72, right: left + 240, top: 107, bottom: 141, width: 168, height: 34 };
    return { dialog, row, to };
  };
  test('1440 px: beside the box, 16 px out, level with To', () => {
    const place = launchTipPlace({ phone: false, viewportWidth: 1440, ...at(1440) });
    expect(place).toEqual({ side: 'right', left: 680 + 16, top: -2, arrow: 0 });
  });
  test('1320 px still fits beside; 1200 px falls back under To, pointing at the chip', () => {
    expect(launchTipPlace({ phone: false, viewportWidth: 1320, ...at(1320) }).side).toBe('right');
    const narrow = launchTipPlace({ phone: false, viewportWidth: 1200, ...at(1200) });
    expect(narrow).toEqual({ side: 'below', left: 72 - 6, top: 48 + 2, arrow: 24 });
    // The boundary is the card and its gaps, exactly.
    const edge = 680 + 2 * (LAUNCH_TIP_WIDTH + 16 + 12);
    expect(launchTipPlace({ phone: false, viewportWidth: edge, ...at(edge) }).side).toBe('right');
    expect(launchTipPlace({ phone: false, viewportWidth: edge - 2, ...at(edge - 2) }).side).toBe('below');
  });
  test("a phone: always over the foot's row, where its To is, its arrow down at the pill, however wide", () => {
    // The foot's row of the card (8 px in from the window's edges), To's pill after the paperclip and Skills.
    const dialog = { left: 0, right: 390, top: 0, bottom: 844, width: 390, height: 844 };
    const row = { left: 9, right: 381, top: 781, bottom: 835, width: 372, height: 54 };
    const to = { left: 107, right: 240, top: 789, bottom: 825, width: 133, height: 36 };
    const place = launchTipPlace({ phone: true, viewportWidth: 2000, dialog, row, to });
    // `top` is the card's distance over the row's bottom edge: the row's height and 8 px.
    expect(place).toEqual({ side: 'above', left: 12, top: 54 + 8, arrow: 107 - 9 - 12 + 22 });
  });
});
