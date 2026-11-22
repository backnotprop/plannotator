/**
 * The risk bars' places (approval "review-risk-bars"). What regresses: a Low judgment, or one with no places (stored
 * before Medium named any), drawing a mark; a file the judgment does not name getting one; one range drawn twice, or a
 * range the diff does not draw marked on lines that hold other code.
 */
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxPullRiskJudgment, InboxPullRiskPlace } from '@plannotator/core/inbox-types';
import { riskBarsOf } from './riskBars';
import { RiskBarsMark, riskBarsLineNotes } from './RiskBarsMark';

const file = (path: string, body: string[]) => ({ path, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,3 +10,${body.length} @@\n${body.join('\n')}\n` });
// New lines 10 context, 11–13 added, 14 context; old lines 10, 11 (removed), 12.
const BILLING = file('src/billing.ts', [' keep', '-old', '+one', '+two', '+three', ' keep']);
const AUTH = file('src/auth.ts', [' keep', '+check', ' keep']);
const README = file('README.md', [' a', '+b', ' c']);
const FILES = [BILLING, AUTH, README];

const place = (file: string, lines: [number, number], side: 'new' | 'old' = 'new'): InboxPullRiskPlace => ({ file, side, lines, why: 'Charges now retry.' });
const judged = (level: InboxPullRiskJudgment['level'], where?: InboxPullRiskPlace[]): InboxPullRiskJudgment => ({ level, why: 'It changes billing.', ...(where ? { where } : {}) });

describe('riskBarsOf', () => {
  test('High: each named file once, each named range once at its first line', () => {
    const bars = riskBarsOf(judged('high', [place('src/billing.ts', [11, 13]), place('src/auth.ts', [11, 11]), place('src/billing.ts', [11, 12])]), FILES);
    expect(bars?.level).toBe('high');
    expect([...bars!.files].sort()).toEqual(['src/auth.ts', 'src/billing.ts']);
    expect(bars!.ranges.map(({ file, side, line }) => `${file} ${side} ${line}`)).toEqual(['src/billing.ts new 11', 'src/auth.ts new 11']);
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
  test('one line note per range, under its first line on its side, saying the level', () => {
    const bars = riskBarsOf(judged('high', [place('src/billing.ts', [12, 13]), place('src/billing.ts', [11, 11], 'old')]), FILES);
    const notes = riskBarsLineNotes(bars, 'github.com/n/b#7');
    expect(notes.map(({ filePath, line, side }) => `${filePath} ${side} ${line}`)).toEqual(['src/billing.ts new 12', 'src/billing.ts old 11']);
    expect(new Set(notes.map((note) => note.id)).size).toBe(2);
    const drawn = renderToStaticMarkup(notes[0]!.render() as ReactElement);
    expect(drawn.match(/role="img"/g)).toHaveLength(1);
    expect(drawn).toContain('aria-label="High risk"');
    expect(drawn).toContain('title="High risk"');
    expect(riskBarsLineNotes(null, 'k')).toEqual([]);
  });

  test('High fills three bars; Medium two', () => {
    const filled = (level: 'high' | 'medium') => (renderToStaticMarkup(<RiskBarsMark level={level} />).match(/<rect(?![^>]*opacity="0.28")/g) ?? []).length;
    expect(filled('high')).toBe(3);
    expect(filled('medium')).toBe(2);
  });
});
