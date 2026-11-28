/**
 * Voice sits behind its own entry (components/reply/replyVoice.ts): the reply box, its field and every part they draw
 * import no voice or recorder code, so a host that passes no `voice` never loads it. The failure this catches: a
 * static import (a value, not a type) that pulls voice.ts, the recorder or the session engine back into the box's
 * graph. The walk reads the source as a bundler would: every `import`/`export … from` that is not type-only, followed
 * through the workspace's own packages.
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const INBOX = resolve(import.meta.dir, '../..');
const PACKAGES = resolve(INBOX, '..');
const ROOT = resolve(PACKAGES, '..');

/** The voice modules a host without voice must never load. */
const VOICE = ['packages/inbox/voice.ts', 'packages/inbox/voiceRecorder.ts', 'packages/inbox/voiceSession.ts', 'packages/inbox/voiceAudio.ts', 'packages/inbox/components/VoiceMic.tsx', 'packages/inbox/components/FieldVoice.tsx'];

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && !candidate.endsWith('/') && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

function target(from: string, spec: string): string | null {
  if (spec.startsWith('.')) return resolveFile(resolve(dirname(from), spec));
  const own = /^@plannotator\/(core|ui)(?:\/(.*))?$/.exec(spec);
  if (own) return resolveFile(join(PACKAGES, own[1]!, own[2] ?? 'index'));
  return null;
}

/** The value imports of a module: `import type …`, `export type …` and `import { type a, type b }` carry none. */
function valueImports(source: string): string[] {
  const specs: string[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(statement)) {
    if (match[4]) {
      specs.push(match[4]);
      continue;
    }
    const clause = match[2]!.trim();
    if (/^type\b/.test(clause)) continue;
    const named = /^\{([\s\S]*)\}$/.exec(clause);
    if (named && named[1]!.split(',').every((part) => part.trim() === '' || /^type\s/.test(part.trim()))) continue;
    specs.push(match[3]!);
  }
  return specs;
}

/** Every module the entry loads, with the first chain that reached each. */
function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      const next = target(file, spec);
      if (!next || seen.has(next)) continue;
      seen.set(next, [...seen.get(file)!, next]);
      queue.push(next);
    }
  }
  return seen;
}

const rel = (file: string) => relative(ROOT, file);

test('the walk sees a value import and skips a type-only one', () => {
  expect(valueImports("import { a, type B } from './x';\nimport type { C } from './y';\nimport { type D } from './z';\nexport { e } from './w';\nimport './side';")).toEqual(['./x', './w', './side']);
});

test('the reply box loads no voice code: it comes only through the voice entry a host passes', () => {
  const box = graph(join(INBOX, 'components/reply/ReplyBox.tsx'));
  const reached = VOICE.filter((file) => box.has(join(ROOT, file))).map((file) => box.get(join(ROOT, file))!.map(rel).join(' -> '));
  expect(reached).toEqual([]);
  // The walk is real: the box's own field is in its graph.
  expect(box.has(join(INBOX, 'parts/ReplyTextField.tsx'))).toBe(true);
});

test('the voice entry is where the recorder comes from', () => {
  const entry = graph(join(INBOX, 'components/reply/replyVoice.ts'));
  expect(entry.has(join(INBOX, 'voiceRecorder.ts'))).toBe(true);
  expect(entry.has(join(INBOX, 'components/VoiceMic.tsx'))).toBe(true);
});

test('the controller loads no voice code, and never the Inbox\'s own Send (its late record is kept in the browser)', () => {
  const composer = graph(join(INBOX, 'components/reply/useReplyComposer.tsx'));
  const banned = [...VOICE, 'packages/inbox/data/actions/sendLanded.ts', 'packages/inbox/data/actions/send.ts'];
  const reached = banned.filter((file) => composer.has(join(ROOT, file))).map((file) => composer.get(join(ROOT, file))!.map(rel).join(' -> '));
  expect(reached).toEqual([]);
  expect(composer.has(join(INBOX, 'components/reply/ReplyBox.tsx'))).toBe(false);
  expect(composer.has(join(INBOX, 'replyDraft.ts'))).toBe(true);
});
