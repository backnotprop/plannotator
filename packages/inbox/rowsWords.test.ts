/**
 * The agent's row settings (core inbox-rows-words.ts, what `plannotator inbox rows set` writes) against the page's
 * controls (rowsControls.ts): one vocabulary, two doors.
 * What this catches: a setting an agent can write that a click cannot (or the reverse); a value that saves a
 * different look from the command than from the page; a label in the command's "before -> after" that is not the
 * page's; `look=` drifting from "Start from"; `rows set` saving part of a refused command, or applying `look=` after
 * the options it was typed with; the instruction block losing its markers (the wake cuts a long message before them).
 */
import { describe, expect, test } from 'bun:test';
import { INBOX_ROWS_OPTIONS, type InboxRowsOption } from '@plannotator/core/inbox-types';
import { INBOX_ROWS_ASK_BLOCK, INBOX_ROWS_ASK_CLOSE, INBOX_ROWS_ASK_OPEN, INBOX_ROWS_LOOKS, INBOX_ROWS_SETTINGS, inboxRowsApply, inboxRowsChangeLines, inboxRowsListing, inboxRowsLookOf } from '@plannotator/core/inbox-types';
import { lookFromRows, rowsFromLook } from './listLook';
import { ROWS_CONTROLS, ROWS_PRESETS, lookWithChoice } from './rowsControls';

const STARTS: InboxRowsOption[][] = [[], ['smallNames'], ['compact', 'smallNames', 'hidePulls'], ['roomy', 'previewTwo', 'marksThreads', 'marksProjects', 'repoLogo'], ['unreadDot', 'marksProjects', 'markDot', 'githubPictures', 'timeBelow'], [...INBOX_ROWS_OPTIONS]];

describe('row settings for an agent', () => {
  test('each setting is one of the page\'s controls: the same label, the same number of choices, in the same order', () => {
    expect(INBOX_ROWS_SETTINGS.map((setting) => [setting.label, setting.values.length])).toEqual(ROWS_CONTROLS.map((control) => [control.label, control.kind === 'switch' ? 2 : control.choices.length]));
    expect(new Set(INBOX_ROWS_SETTINGS.map((setting) => setting.name)).size).toBe(INBOX_ROWS_SETTINGS.length);
  });

  test('every value saves exactly what the same choice on the page saves, from several looks', () => {
    for (const start of STARTS) {
      const rows = rowsFromLook(lookFromRows(start));
      INBOX_ROWS_SETTINGS.forEach((setting, i) => {
        const control = ROWS_CONTROLS[i]!;
        setting.values.forEach((entry, v) => {
          const click = control.kind === 'switch' ? entry.value === 'on' : control.choices[v]!.id;
          const applied = inboxRowsApply(rows, [`${setting.name}=${entry.value}`]);
          expect([setting.name, entry.value, 'rows' in applied ? applied.rows : applied.error]).toEqual([setting.name, entry.value, rowsFromLook(lookWithChoice(lookFromRows(rows), control, click))]);
        });
      });
    }
  });

  test('look= is "Start from": the four looks, their lists, and their names read back', () => {
    expect(INBOX_ROWS_LOOKS.map((look) => [look.value, look.label, rowsFromLook(lookFromRows(look.rows))])).toEqual(ROWS_PRESETS.map((preset) => [preset.id, preset.label, rowsFromLook(preset.look)]));
    for (const look of INBOX_ROWS_LOOKS) expect(inboxRowsLookOf(look.rows)).toBe(look.value);
    expect(inboxRowsLookOf(['smallNames', 'hidePulls'])).toBeNull();
  });

  test('one command is one result: look= first wherever it is typed, and any refused part saves nothing', () => {
    const typedLast = inboxRowsApply(['compact', 'hideAgents'], ['pull-requests=off', 'letter-badges=off', 'look=detailed']);
    expect(typedLast).toEqual({ rows: ['roomy', 'previewTwo', 'hidePulls'] });
    expect(inboxRowsApply(['smallNames'], ['spacing=compact', 'time=ago'])).toEqual({ rows: ['compact', 'smallNames', 'relativeTime'] });
    for (const pairs of [['spacing=compact', 'density=1'], ['spacing=tight'], ['spacing=compact', 'spacing=roomy'], ['spacing'], ['look=custom']]) expect(Object.keys(inboxRowsApply(['smallNames'], pairs))).toEqual(['error']);
  });

  test('a change reads in the page\'s words, and the listing shows every setting with its value now', () => {
    expect(inboxRowsChangeLines(['smallNames'], ['compact', 'smallNames', 'relativeTime', 'hidePulls'])).toEqual(['Spacing: Comfortable -> Compact', 'Time: 9:12 PM -> 10m ago', 'Pull requests: on -> off']);
    const listing = inboxRowsListing(['compact', 'smallNames']);
    for (const setting of INBOX_ROWS_SETTINGS) expect(listing).toContain(`\n${setting.name}=`);
    expect(listing).toContain('\nspacing=compact ');
    expect(listing).toContain('\nbadge-shape=none ');
    expect(listing).toContain('\nlook=none ');
  });

  test('the instruction block opens and closes with its markers, each on its own line', () => {
    const lines = INBOX_ROWS_ASK_BLOCK.split('\n');
    expect([lines[0], lines.at(-1)]).toEqual([INBOX_ROWS_ASK_OPEN, INBOX_ROWS_ASK_CLOSE]);
  });
});
