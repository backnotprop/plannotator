import { describe, expect, test } from 'bun:test';
import { baselineProblems } from './no-comments/guard.ts';
import type { KeepEntry } from './no-comments/rules.ts';
import { stripSource } from './no-comments/strip-source.ts';

const NO_KEEP: KeepEntry[] = [];

function strip(source: string, path = 'file.ts', keepList = NO_KEEP): string {
  const result = stripSource(path, source, keepList);
  if (!result.ok) throw new Error(result.reason);
  return result.text;
}

describe('what is removed', () => {
  test('a line that held only a comment goes, and a trailing comment is cut with its spaces', () => {
    expect(strip('const a = 1; // one\n// alone\nconst b = 2;   /* two */\n')).toBe('const a = 1;\nconst b = 2;\n');
  });

  test('JSDoc and a multi-line block go whole, and a file header leaves no blank line on top', () => {
    expect(strip('/**\n * Header.\n */\n\nimport x from "x";\n/**\n * Doc.\n */\nexport const y = x;\n')).toBe('import x from "x";\nexport const y = x;\n');
  });

  test('a comment inside a line goes without joining tokens', () => {
    expect(strip('call(/* a */ x, y /* b */);\nconst z = /* c */ 5;\nlet w = p/* d */in q;\n')).toBe('call(x, y);\nconst z = 5;\nlet w = p in q;\n');
  });

  test('a block comment holding a line break between code keeps the line break', () => {
    expect(strip('function f() {\n  return /*\n  */ x;\n}\n')).toBe('function f() {\n  return\n  x;\n}\n');
  });

  test('blank lines left by a removal collapse to at most one, and none beside a brace', () => {
    expect(strip('a();\n\n// one\n\n// two\n\nb();\n')).toBe('a();\n\nb();\n');
    expect(strip('a();\n// one\nb();\n')).toBe('a();\nb();\n');
    expect(strip('if (x) {\n\n  // why\n  a();\n\n  // trailing\n}\n')).toBe('if (x) {\n  a();\n}\n');
    expect(strip('a();\n\n\nb(); // c\n')).toBe('a();\n\n\nb();\n');
  });

  test('a block left with only a removed comment keeps its braces as written', () => {
    expect(strip('try {\n  run();\n} catch {\n  // ignored\n}\n')).toBe('try {\n  run();\n} catch {\n}\n');
    expect(strip('try { run(); } catch { /* ignored */ }\n')).toBe('try { run(); } catch { }\n');
    expect(strip('function noop() {\n  // nothing\n}\nconst arrow = () => {\n  // nothing\n};\n')).toBe('function noop() {\n}\nconst arrow = () => {\n};\n');
    expect(strip('if (a) {\n  b();\n} else /* other */ {\n  c();\n}\n')).toBe('if (a) {\n  b();\n} else {\n  c();\n}\n');
  });

  test('comments in a template expression, a type literal and an enum go', () => {
    expect(strip('const s = `a ${/* x */ b} c`;\n')).toBe('const s = `a ${b} c`;\n');
    expect(strip('type T = {\n  // the id\n  id: string; // trailing\n};\nenum E {\n  /** first */\n  A,\n  B, // second\n}\n')).toBe(
      'type T = {\n  id: string;\n};\nenum E {\n  A,\n  B,\n}\n',
    );
  });

  test('a JSX comment expression goes whole, and its line with it', () => {
    const before = 'const v = (\n  <div>\n    {/* a note */}\n    <span>one</span> {/* inline */}<b>two</b>\n  </div>\n);\n';
    expect(strip(before, 'view.tsx')).toBe('const v = (\n  <div>\n    <span>one</span> <b>two</b>\n  </div>\n);\n');
  });
});

describe('what is left exactly as it is', () => {
  test('strings, templates, regexes and JSX text that look like comments', () => {
    const source = [
      'const url = "https://example.com/*path*/";',
      'const t = `// not ${"/* a */"} comment`;',
      'const re = /\\/\\/ not a comment/g;',
      'const div = a / b / c;',
      'const v = <p>// text /* also text */</p>;',
      '',
    ].join('\n');
    expect(strip(source, 'view.tsx')).toBe(source);
  });

  test('directives for tools that run here, license notices and a shebang stay byte for byte', () => {
    const source = [
      '#!/usr/bin/env bun',
      '/// <reference types="bun-types" />',
      '// Copyright (c) 2025 Someone: MIT License,',
      '// permission is hereby granted.',
      '// @ts-expect-error a reason',
      'const a: number = "x";',
      'const b = /* @__PURE__ */ make();',
      'const c = import(/* @vite-ignore */ path);',
      '/** @deprecated use d2 */',
      'export const d = 1;',
      '',
    ].join('\n');
    expect(strip(source)).toBe(source);
  });

  test('lint directives go: no linter runs in this repo', () => {
    expect(strip('run(); // eslint-disable-line no-console\n// biome-ignore lint/x: because\nwalk();\n// oxlint-disable no-control-regex\n')).toBe('run();\nwalk();\n');
  });

  test('prose that mentions a directive is not one', () => {
    expect(strip('// a sentence about eslint and @ts-ignore\nconst x = 1;\n')).toBe('const x = 1;\n');
  });

  test('a comment on the keep-list stays, any other is removed', () => {
    const keep: KeepEntry[] = [{ path: '*', pattern: '^// inbox-guard: own child', readBy: 'a test' }];
    expect(strip('kill(pid); // inbox-guard: own child (spawned here)\nother(); // why\n', 'a.test.ts', keep)).toBe('kill(pid); // inbox-guard: own child (spawned here)\nother();\n');
  });

  test('stripping twice changes nothing more', () => {
    const once = strip('// a\nconst x = 1; /* b */\n\n// c\n\nfoo(/* d */);\n');
    expect(strip(once)).toBe(once);
  });

  test('a file that does not parse is refused and left alone', () => {
    expect(stripSource('broken.ts', 'const = ; // x\n', NO_KEEP).ok).toBe(false);
  });
});

describe('the baseline', () => {
  test('a new file with comments, a baselined file that grew, and one that is clean all fail with the fix to run', () => {
    const counts = new Map([
      ['new.ts', 2],
      ['grew.ts', 5],
      ['clean.ts', 0],
      ['same.ts', 3],
      ['fine.ts', 0],
    ]);
    const baseline = new Map([
      ['grew.ts', 4],
      ['clean.ts', 1],
      ['same.ts', 3],
      ['gone.ts', 1],
    ]);
    const problems = baselineProblems(counts, baseline);
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain('run `bun scripts/strip-comments.ts new.ts`');
    expect(problems.join('\n')).toContain('run `bun scripts/strip-comments.ts grew.ts`');
    expect(problems.join('\n')).toContain('clean.ts has no comments left');
    expect(problems.join('\n')).toContain('gone.ts is in');
  });
});
