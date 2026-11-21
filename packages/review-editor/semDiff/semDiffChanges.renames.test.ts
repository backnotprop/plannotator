import { describe, expect, test } from 'bun:test';
import { semanticDiffFile, languageForPath, type SemanticDiffOperation } from '@plannotator/sem-jiff';
import { semDiffChanges } from './semDiffChanges';

const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

async function renames(path: string, before: string, after: string): Promise<[string | null, string][]> {
  const result = await semanticDiffFile(languageForPath(path)!, before, after, path);
  return semDiffChanges(path, result.semanticOperations, before, after)
    .filter((change) => change.changeType === 'renamed')
    .map((change) => [change.oldEntityName, change.entityName]);
}

const sources: [string, string, string, Record<'variable' | 'parameter' | 'function', [string, string]>][] = [
  ['TypeScript', 'src/a.ts',
    lines('function total(items: number[]) {', '  const amt = items.length;', '  return amt;', '}', '', 'export function useIt() {', '  return total([]);', '}'),
    { variable: ['amt', 'lineTotal'], parameter: ['items', 'rows'], function: ['total', 'grandTotal'] }],
  ['PHP', 'api/Refund.php',
    lines('<?php', 'function total($items) {', '  $amt = (float) (count($items) * 2);', '  return $amt;', '}', '', 'function useIt() {', '  return total([]);', '}'),
    { variable: ['$amt', '$requested'], parameter: ['$items', '$rows'], function: ['total', 'grandTotal'] }],
  ['Ruby', 'app/a.rb',
    lines('class Till', '  def initialize(start)', '    @count = start', '  end', '', '  def total(items)', '    acc = items.size + @count', '    acc', '  end', '', '  def use_it', '    total([])', '  end', 'end'),
    { variable: ['@count', '@tally'], parameter: ['items', 'rows'], function: ['total', 'grand_total'] }],
  ['Kotlin', 'app/A.kt',
    lines('fun total(items: List<Int>): Int {', '    val acc = items.sum()', '    return acc', '}', '', 'fun useIt(): Int {', '    return total(listOf())', '}'),
    { variable: ['acc', 'subtotal'], parameter: ['items', 'rows'], function: ['total', 'grandTotal'] }],
  ['Python', 'tools/a.py',
    lines('def total(items):', '    acc = sum(items)', '    return acc', '', '', 'def use_it():', '    return total([])'),
    { variable: ['acc', 'subtotal'], parameter: ['items', 'rows'], function: ['total', 'grand_total'] }],
  ['Go', 'pkg/a.go',
    lines('package a', '', 'func total(items []int) int {', '\tacc := 0', '\tfor _, i := range items {', '\t\tacc += i', '\t}', '\treturn acc', '}', '', 'func Use() int {', '\treturn total(nil)', '}'),
    { variable: ['acc', 'sum'], parameter: ['items', 'rows'], function: ['total', 'grandTotal'] }],
  ['Rust', 'src/a.rs',
    lines('fn total(items: &[i32]) -> i32 {', '    let acc: i32 = items.iter().sum();', '    acc', '}', '', 'fn use_it() -> i32 {', '    total(&[])', '}'),
    { variable: ['acc', 'subtotal'], parameter: ['items', 'rows'], function: ['total', 'grand_total'] }],
  ['Java', 'src/A.java',
    lines('class A {', '    int total(int[] items) {', '        int acc = items.length;', '        return acc;', '    }', '', '    int useIt() {', '        return total(null);', '    }', '}'),
    { variable: ['acc', 'subtotal'], parameter: ['items', 'rows'], function: ['total', 'grandTotal'] }],
  ['C#', 'src/A.cs',
    lines('class A', '{', '    int Total(int[] items)', '    {', '        var acc = items.Length;', '        return acc;', '    }', '', '    int UseIt()', '    {', '        return Total(null);', '    }', '}'),
    { variable: ['acc', 'subtotal'], parameter: ['items', 'rows'], function: ['Total', 'GrandTotal'] }],
];

const swap = (text: string, from: string, to: string) => text.replace(new RegExp(`(?<![\\w$@])${from.replace(/[$]/g, '\\$&')}\\b`, 'g'), to);
const cases = sources.flatMap(([language, path, before, kinds]) =>
  (Object.entries(kinds) as [string, [string, string]][]).map(([kind, pair]) => [`${language} ${kind}`, path, before, swap(before, ...pair), pair] as const));

describe('a rename reads old name -> new name in every language', () => {
  test.each(cases)('%s', async (_label, path, before, after, expected) => {
    expect(await renames(path, before, after)).toEqual([expected]);
  });

  const at = (text: string, word: string) => {
    const rows = text.split('\n');
    const line = rows.findIndex((row) => new RegExp(`\\b${word}\\b`).test(row));
    const character = rows[line]!.search(new RegExp(`\\b${word}\\b`));
    return { start: { line: line + 1, character }, end: { line: line + 1, character: character + word.length } };
  };
  const renameOp = (before: string, after: string, pairs: [string, string][]) => ({
    type: 'renamed',
    lines: { old: [], new: [] },
    spans: pairs.map(([from, to]) => {
      const old = at(before, from);
      const next = at(after, to);
      return { role: 'focus', relation: 'replaced', old: [old], new: [next], linePairs: [{ old: { start: old.start.line, end: old.start.line }, new: { start: next.start.line, end: next.start.line } }] };
    }),
  }) as unknown as SemanticDiffOperation;
  const pairsOf = (path: string, before: string, after: string, pairs: [string, string][]) =>
    semDiffChanges(path, [renameOp(before, after, pairs)], before, after).map((change) => [change.oldEntityName, change.entityName, change.startLine]);

  test('Swift renames of a variable, a parameter and a function', () => {
    const before = lines('func total(_ items: [Int]) -> Int {', '    let sum = items.reduce(0, +)', '    return sum', '}');
    const after = lines('func grandTotal(_ rows: [Int]) -> Int {', '    let acc = rows.reduce(0, +)', '    return acc', '}');
    expect(pairsOf('Sources/A.swift', before, after, [['total', 'grandTotal'], ['items', 'rows'], ['sum', 'acc']])).toEqual([
      ['total', 'grandTotal', 1],
      ['items', 'rows', 1],
      ['sum', 'acc', 2],
    ]);
  });

  test('Ruby symbols keep their colon, a PHP property keeps no sigil', () => {
    const rubyBefore = lines('class A', '  attr_reader :count', 'end');
    const rubyAfter = lines('class A', '  attr_reader :tally', 'end');
    expect(pairsOf('app/a.rb', rubyBefore, rubyAfter, [['count', 'tally']])).toEqual([[':count', ':tally', 2]]);
    const phpBefore = lines('<?php', 'class A {', '  function f() { return $this->amt; }', '}');
    const phpAfter = lines('<?php', 'class A {', '  function f() { return $this->requested; }', '}');
    expect(pairsOf('A.php', phpBefore, phpAfter, [['amt', 'requested']])).toEqual([['amt', 'requested', 3]]);
  });
});
