/**
 * The risk bars' places (approval "review-risk-bars"). What regresses: a Low judgment, or one with no places (stored
 * before Medium named any), drawing a mark; a file the judgment does not name getting one; one range drawn twice, or a
 * range the diff does not draw marked on lines that hold other code.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxPullRiskJudgment, InboxPullRiskPlace } from '@plannotator/core/inbox-types';
import { riskBarsOf } from './riskBars';
import { riskBarsLineMarks, riskBarsPaint } from './riskBarsMarks';

const file = (path: string, body: string[]) => ({ path, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,3 +10,${body.length} @@\n${body.join('\n')}\n` });
// New lines 10 context, 11–13 added, 14 context; old lines 10, 11 (removed), 12.
const BILLING = file('src/billing.ts', [' keep', '-old', '+one', '+two', '+three', ' keep']);
const AUTH = file('src/auth.ts', [' keep', '+check', ' keep']);
const README = file('README.md', [' a', '+b', ' c']);
const FILES = [BILLING, AUTH, README];

const place = (file: string, lines: [number, number], side: 'new' | 'old' = 'new'): InboxPullRiskPlace => ({ file, side, lines, why: 'Charges now retry.' });
const judged = (level: InboxPullRiskJudgment['level'], where?: InboxPullRiskPlace[]): InboxPullRiskJudgment => ({ level, why: 'It changes billing.', ...(where ? { where } : {}) });

describe('riskBarsOf', () => {
  test('High: each named file once, each named range once at its first line; two places on one line share its mark and both reasons', () => {
    const second = { ...place('src/billing.ts', [11, 12]), why: 'And it skips the lock.', rule: 'Anything in billing.' };
    const bars = riskBarsOf(judged('high', [place('src/billing.ts', [11, 13]), place('src/auth.ts', [11, 11]), second]), FILES);
    expect(bars?.level).toBe('high');
    expect([...bars!.files].sort()).toEqual(['src/auth.ts', 'src/billing.ts']);
    expect(bars!.ranges.map(({ file, side, line }) => `${file} ${side} ${line}`)).toEqual(['src/billing.ts new 11', 'src/auth.ts new 11']);
    expect(bars!.ranges[0]!.notes).toEqual([{ why: 'Charges now retry.' }, { why: 'And it skips the lock.', rule: 'Anything in billing.' }]);
    expect(riskBarsLineMarks(bars)[0]!.label).toBe('High risk: Charges now retry. your rule “Anything in billing.”: And it skips the lock.');
  });

  test('the mark’s name says the person’s rule as its card does, when the place named one', () => {
    const ruled = { ...place('src/billing.ts', [11, 11]), rule: 'Anything in billing.' };
    expect(riskBarsLineMarks(riskBarsOf(judged('high', [ruled]), FILES))[0]!.label).toBe('High risk · your rule “Anything in billing.”: Charges now retry.');
    expect(riskBarsLineMarks(riskBarsOf(judged('medium', [{ ...ruled, why: '' }]), FILES))[0]!.label).toBe('Medium risk · your rule “Anything in billing.”');
  });

  test('Medium carries its places as High does; a removed line is marked on the old side', () => {
    const bars = riskBarsOf(judged('medium', [place('src/billing.ts', [11, 11], 'old')]), FILES);
    expect(bars?.level).toBe('medium');
    expect([...bars!.files]).toEqual(['src/billing.ts']);
    expect(bars!.ranges.map(({ file, side, line }) => `${file} ${side} ${line}`)).toEqual(['src/billing.ts old 11']);
  });

  test('Low, no judgment, or a judgment stored with no places: nothing at all', () => {
    expect(riskBarsOf(judged('low', [place('src/billing.ts', [11, 13])]), FILES)).toBeNull();
    expect(riskBarsOf(null, FILES)).toBeNull();
    expect(riskBarsOf(judged('medium'), FILES)).toBeNull();
    expect(riskBarsOf(judged('high', []), FILES)).toBeNull();
  });

  test('a range the diff does not draw keeps its file’s tree mark and gets no mark in the diff', () => {
    const bars = riskBarsOf(judged('high', [place('src/billing.ts', [40, 41]), place('src/gone.ts', [1, 1])]), FILES);
    expect([...bars!.files]).toEqual(['src/billing.ts']);
    expect(bars!.ranges).toEqual([]);
    // Only files outside the diff: nothing to mark anywhere.
    expect(riskBarsOf(judged('high', [place('src/gone.ts', [1, 1])]), FILES)).toBeNull();
  });
});

describe('the diff’s marks', () => {
  test('one mark per range, on its first line on its side, saying the level; none with no bars', () => {
    const bars = riskBarsOf(judged('high', [place('src/billing.ts', [12, 13]), place('src/billing.ts', [11, 11], 'old')]), FILES);
    const marks = riskBarsLineMarks(bars);
    expect(marks.map(({ filePath, line, side, label }) => `${filePath} ${side} ${line} ${label}`)).toEqual(['src/billing.ts new 12 High risk: Charges now retry.', 'src/billing.ts old 11 High risk: Charges now retry.']);
    expect(riskBarsLineMarks(null)).toEqual([]);
  });

  test('High fills three bars; Medium two, its third faint', () => {
    const images = (level: 'high' | 'medium') => /background-image: ([^;]*);/.exec(riskBarsPaint(level))![1]!.split(/,\s*(?=linear-gradient)/);
    const faint = (image: string) => image.includes('30%, transparent');
    expect(images('high').map(faint)).toEqual([false, false, false]);
    expect(images('medium').map(faint)).toEqual([false, false, true]);
  });
});
