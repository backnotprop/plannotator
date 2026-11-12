import type { ShapeExample, ShapeExampleCheck, ShapeExampleInput, ShapeExampleStep } from '@plannotator/core/shape';

const WHEN = 'packages/inbox/snoozeIntro.ts';
const WHO = 'packages/server/inbox-snooze-intro.ts';
const ROWS = 'packages/inbox/snoozeIntroRows.ts';

const at = (path: string, line: number) => ({ path, line });
const pass = (code: string, saw: string, more: Partial<ShapeExampleCheck> = {}): ShapeExampleCheck => ({ code, saw, result: 'pass', ...more });

const LEAVE_SIG = 'snoozeIntroLeaveCounts(visit: SnoozeIntroVisit, now: number, row: InboxListRow | null): boolean';
const CLAIM_SIG = "snoozeIntroMayClaim(gate: Omit<SnoozeIntroGate, 'toast'>, now: Date = new Date()): boolean";
const DUE_SIG = 'snoozeIntroDue(saved: SnoozeIntroSaved | undefined, now: Date, release: boolean): boolean';

function leave(secs: number, text: string, detail?: string): ShapeExampleStep {
  return {
    part: 'how-leave',
    tag: `${secs} s, past the 5 s it needs`,
    text,
    ...(detail ? { detail } : {}),
    inputs: [
      { name: 'visit.at', value: '12:00:00.0', from: at(WHEN, 163) },
      { name: 'now', value: `12:00:0${secs}.0`, from: at(WHEN, 161) },
      { name: 'row.waiting_on_person', value: 'true', type: 'boolean', from: at(WHEN, 165) },
      { name: 'row.unsent', value: 'false', type: 'boolean', from: at(WHEN, 165) },
    ],
    signature: LEAVE_SIG,
    checks: [
      { code: 'now - visit.at >= SNOOZE_INTRO_TIMES.readMs', constant: '5_000', saw: `${secs}_000`, result: 'pass' },
      pass('snoozeIntroTargetHolds(row)', 'waits, nothing unsent', { decides: true }),
    ],
    output: { name: 'moment', value: `{ at: 12:00:0${secs}.0 }`, type: 'SnoozeIntroVisit', note: 'set at line 166' },
    code: at(WHEN, 80),
  };
}

function settle(secs: number, detail?: string): ShapeExampleStep {
  return {
    arrow: 'checks',
    tag: '2.5 s',
    text: 'The page waits for the list to settle',
    ...(detail ? { detail } : {}),
    inputs: [
      { name: 'moment', value: `{ at: 12:00:0${secs}.0 }`, from: { step: 1 } },
      { name: 'input.clear', value: 'true', type: 'boolean', from: at(WHEN, 182) },
      { name: 'settledMs', value: '2_500', type: 'number', reading: '2.5 s', from: 'listIntro.ts:23' },
    ],
    signature: 'useSnoozeIntro(input: SnoozeIntroInput)',
    checks: [
      pass('moment && input.clear && watching', 'nothing over the page'),
      pass('setTimeout(…, SNOOZE_INTRO_TIMES.settledMs)', 'fired, no change', { decides: true }),
    ],
    output: { name: 'settled', value: 'true', type: 'boolean', note: `at 12:00:${secs === 9 ? '11.5' : '10.5'}` },
    code: at(WHEN, 180),
  };
}

function claimInputs(pageAge: string, reading: string): ShapeExampleInput[] {
  return [
    { name: 'settled', value: 'true', type: 'boolean', from: { step: 2 } },
    { name: 'heldBack()', value: 'false', type: 'boolean', from: at(WHEN, 195) },
    { name: 'gate.pageAge', value: pageAge, type: 'number', reading, from: at(WHEN, 196) },
    { name: 'gate.rows.length', value: '6', type: 'number', from: at(WHEN, 105) },
    { name: 'readAndLeft', value: '2', type: 'number', reading: 'rows', from: at(ROWS, 27) },
  ];
}

export const SNOOZE_EXAMPLES: ShapeExample[] = [
  {
    name: 'It opens',
    title: 'You leave a thread you just read',
    lead: 'It opens 2.5 s after you leave, once the page’s rules and the Inbox’s all hold. Then it never shows again.',
    steps: [
      leave(9, 'You read a thread that waits on you for 9 s, then go back to the list with nothing typed', 'The thread still waits on you, and nothing of yours is unsent in it.'),
      settle(9, 'Any change of thread or list starts the wait again.'),
      {
        part: 'how-calm',
        tagAt: 'bottom',
        tag: 'all hold',
        text: 'The page checks its own rules',
        detail: 'Nothing typed, open 4 min (needs 1), 6 threads (needs 3), 2 read and left a day ago (needs 2).',
        inputs: claimInputs('240_000', '4 min'),
        signature: CLAIM_SIG,
        checks: [
          pass('!now.heldBack()', 'nothing typed'),
          pass('snoozeIntroWanted(gate)', 'due, not blocked'),
          { code: 'gate.pageAge >= SNOOZE_INTRO_TIMES.pageAgeMs', constant: '60_000', saw: '240_000', result: 'pass' },
          { code: 'gate.rows.length >= LIST_INTRO_MIN_ROWS', constant: '3', saw: '6', result: 'pass' },
          { code: 'snoozeIntroNeed(gate.rows, now)', constant: 'needs 2', saw: 'true', result: 'pass', decides: true },
        ],
        output: { name: 'mayClaim', value: 'true', type: 'boolean' },
        code: at(WHEN, 118),
      },
      {
        part: 'how-who',
        tag: '3 days in, never shown',
        text: 'The Inbox checks who you are, and stamps it shown',
        detail: 'First use 3 days ago (needs 2), never snoozed, never shown.',
        inputs: [
          { name: 'mayClaim', value: 'true', type: 'boolean', from: { step: 3 } },
          { name: 'saved.firstUseAt', value: "'2026-11-01T09:12Z'", type: 'string', reading: '3 d ago', from: at(WHO, 19) },
          { name: 'saved.snoozedAt', value: 'undefined', from: at(WHO, 21) },
          { name: 'saved.shownAt', value: 'undefined', from: at(WHO, 23) },
          { name: 'release', value: 'true', type: 'boolean', from: 'inbox.ts' },
        ],
        signature: DUE_SIG,
        checks: [
          pass('release', 'true'),
          pass('!saved.snoozedAt && !saved.shownAt', 'neither set'),
          { code: 'now.getTime() - Date.parse(saved.firstUseAt) >= SNOOZE_INTRO_TENURE_MS', constant: '2 days', saw: '3 d 2 h', result: 'pass', decides: true },
        ],
        output: { name: 'answer.show', value: 'true', type: 'boolean', note: 'shownAt stamped' },
        code: at(WHO, 30),
      },
      {
        arrow: 'all-hold',
        part: 'how-dialog',
        tag: 'opens',
        text: 'The dialog opens once the page is free',
        inputs: [
          { name: 'answer.show', value: 'true', type: 'boolean', from: { step: 4 } },
          { name: 'snoozedHere', value: 'false', type: 'boolean', from: at(WHEN, 103) },
          { name: 'heldBack()', value: 'false', type: 'boolean', from: at(WHEN, 226) },
        ],
        signature: 'useSnoozeIntro(input: SnoozeIntroInput)',
        checks: [
          pass('!now.snoozedHere && snoozeIntroTargetHolds(row)', 'still waits'),
          pass('!now.heldBack() && !now.toast && now.clear', 'page free', { decides: true }),
        ],
        output: { name: 'stage', value: "'open'", type: 'SnoozeIntroStage', note: 'renders <SnoozeIntro>' },
        code: at(WHEN, 227),
      },
      {
        arrow: 'closes',
        part: 'how-again',
        tagAt: 'bottom',
        tag: 'never again',
        text: 'You press Got it, and it never shows again',
        detail: 'It was stamped shown when the Inbox said yes.',
        inputs: [
          { name: 'stage', value: "'open'", from: { step: 5 } },
          { name: 'close()', value: 'Got it', from: at(WHEN, 237) },
          { name: 'saved.shownAt', value: "'2026-11-04T12:00:11Z'", type: 'string', from: 'stamped at the claim' },
        ],
        signature: DUE_SIG,
        checks: [{ code: '!saved.shownAt', saw: 'set', result: 'fail', decides: true }],
        output: { name: 'due', value: 'false', type: 'boolean', note: 'on every load after' },
        code: at(WHO, 31),
      },
    ],
  },
  {
    name: 'Nothing shows',
    title: 'You leave a thread 40 s after opening the Inbox',
    lead: 'The page’s rules fail, so nothing shows and the Inbox is never asked. The next leave is the next chance.',
    steps: [
      leave(8, 'You read a thread that waits on you for 8 s, then go back to the list'),
      settle(8),
      {
        part: 'how-calm',
        tagAt: 'bottom',
        tag: 'open 40 s, needs 1 min',
        text: 'The page checks its own rules',
        detail: 'The page must be open a minute before it may ask the Inbox.',
        inputs: claimInputs('40_000', '40 s'),
        signature: CLAIM_SIG,
        checks: [
          pass('!now.heldBack()', 'nothing typed'),
          pass('snoozeIntroWanted(gate)', 'due, not blocked'),
          { code: 'gate.pageAge >= SNOOZE_INTRO_TIMES.pageAgeMs', constant: '60_000', saw: '40_000', result: 'fail', decides: true, short: '20_000 short (20 s)' },
          { code: 'gate.rows.length >= LIST_INTRO_MIN_ROWS', constant: '3', result: 'not-reached' },
          { code: 'snoozeIntroNeed(gate.rows, now)', constant: 'needs 2', result: 'not-reached' },
        ],
        output: { name: 'mayClaim', value: 'false', type: 'boolean' },
        code: at(WHEN, 120),
      },
      {
        arrow: 'any-fails',
        part: 'how-nothing',
        tag: 'still due',
        text: 'Nothing shows, and the moment is dropped',
        detail: 'The Inbox was never asked, so the dialog stays due for a later leave.',
        inputs: [{ name: 'mayClaim', value: 'false', type: 'boolean', from: { step: 3 } }],
        signature: 'useSnoozeIntro(input: SnoozeIntroInput)',
        checks: [{ code: '!snoozeIntroMayClaim(…) || !snoozeIntroTargetHolds(…)', saw: 'true', result: 'pass', decides: true }],
        output: { name: 'moment', value: 'null', type: 'SnoozeIntroVisit | null', note: 'Inbox never asked' },
        code: at(WHEN, 197),
      },
    ],
  },
];
