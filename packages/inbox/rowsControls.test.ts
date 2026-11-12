import { describe, expect, test } from 'bun:test';
import { INBOX_ROWS_DEFAULT, INBOX_ROWS_OPTIONS, inboxRowsList, inboxRowsRead } from '@plannotator/core/inbox-types';
import { LIST_LOOK_OFF, lookFromRows, rowsFromLook, type ListLook } from './listLook';
import { ROWS_CONTROLS, ROWS_MAIN_CONTROLS, ROWS_MORE_CONTROLS, ROWS_PRESETS, lookFromControlValues, lookWithChoice, rowsChangeWords, rowsControlValues, rowsPreset } from './rowsControls';

function everyStoredLook(): string[][] {
  const seen = new Map<string, string[]>();
  const n = INBOX_ROWS_OPTIONS.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const names: string[] = [];
    for (let bit = 0; bit < n; bit++) if (mask & (1 << bit)) names.push(INBOX_ROWS_OPTIONS[bit]!);
    const kept = inboxRowsRead(names)!;
    const key = kept.join(',');
    if (!seen.has(key)) seen.set(key, kept);
  }
  return [...seen.values()];
}

describe('Settings → Rows control model', () => {
  test('every stored look reads into the controls and writes back the identical list', () => {
    const looks = everyStoredLook();
    expect(looks.length).toBe(774_144);
    let bad: { stored: string[]; back: string[] } | null = null;
    for (const stored of looks) {
      const back = rowsFromLook(lookFromControlValues(rowsControlValues(lookFromRows(stored))));
      if (back.length !== stored.length || back.some((name, i) => name !== stored[i])) {
        bad = { stored, back };
        break;
      }
    }
    expect(bad).toBeNull();
  }, 300_000);

  test('every option can be turned on and turned off by one choice, and every choice of every control can be picked', () => {
    const starts: ListLook[] = [LIST_LOOK_OFF, ...INBOX_ROWS_OPTIONS.map((name) => lookFromRows([name, 'marksThreads', 'marksProjects'])), lookFromRows(['marksProjects', 'markDot']), lookFromRows(['unreadDot'])];
    const clicks = starts.flatMap((start) => ROWS_CONTROLS.flatMap((control) => (control.kind === 'switch' ? [true, false] : control.choices.map((choice) => choice.id)).map((value) => ({ control, value, start, end: lookWithChoice(start, control, value) }))));
    for (const name of INBOX_ROWS_OPTIONS) {
      const owned = clicks.filter((click) => click.control.keys.includes(name));
      expect([name, owned.some((click) => !click.start[name] && click.end[name]), owned.some((click) => click.start[name] && !click.end[name])]).toEqual([name, true, true]);
    }
    for (const click of clicks) expect([click.control.id, click.control.get(click.end)]).toEqual([click.control.id, click.value]);
  });

  test('each option belongs to exactly one control: 8 first, 9 under More choices', () => {
    expect([ROWS_MAIN_CONTROLS.length, ROWS_MORE_CONTROLS.length]).toEqual([8, 9]);
    expect(ROWS_CONTROLS.flatMap((control) => control.keys).sort()).toEqual([...INBOX_ROWS_OPTIONS].sort());
  });

  test('a look saved before Pull requests existed shows them; hidePulls saves and reads back, with no rival', () => {
    const pulls = ROWS_CONTROLS.find((control) => control.id === 'pulls')!;
    for (const stored of [[], ['smallNames'], ['compact', 'smallNames', 'statusMark'], INBOX_ROWS_OPTIONS.filter((name) => name !== 'hidePulls')]) expect(pulls.get(lookFromRows(stored))).toBe(true);
    expect(inboxRowsList(['smallNames', 'hidePulls'])).toEqual(['smallNames', 'hidePulls']);
    expect(rowsFromLook(lookWithChoice(lookFromRows(['compact', 'smallNames']), pulls, false))).toEqual(['compact', 'smallNames', 'hidePulls']);
    expect(rowsFromLook(lookWithChoice(lookFromRows(['compact', 'smallNames', 'hidePulls']), pulls, true))).toEqual(['compact', 'smallNames']);
  });

  test('the presets write exactly these lists: three as before this page, Dense new, none with Pull requests hidden', () => {
    expect(Object.fromEntries(ROWS_PRESETS.map((preset) => [preset.id, rowsFromLook(preset.look)]))).toEqual({
      balanced: [...INBOX_ROWS_DEFAULT],
      dense: ['compact', 'smallNames', 'relativeTime', 'dividers', 'statusMark'],
      minimal: ['smallNames', 'hidePreview', 'titleFirst'],
      detailed: ['roomy', 'previewTwo', 'marksThreads', 'marksProjects', 'repoLogo'],
    });
    for (const preset of ROWS_PRESETS) expect(inboxRowsList(rowsFromLook(preset.look))).toEqual(rowsFromLook(preset.look));
    expect(rowsPreset(lookFromRows(['smallNames', 'hidePulls']))).toBeNull();
  });

  test('the change line names each control that moved, with its new value', () => {
    const dense = ROWS_PRESETS.find((preset) => preset.id === 'dense')!.look;
    expect(rowsChangeWords(lookFromRows(['smallNames']), dense)).toEqual(['Spacing → Compact', 'Time → 10m ago', 'When a thread needs you → One mark', 'Lines between rows → on']);
    expect(rowsChangeWords(dense, dense)).toEqual([]);
  });
});
