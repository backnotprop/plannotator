// Extracted functions: hand-made cases, including ones that must not count.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';

const load = (name: string) => {
  const dir = new URL(`./fixtures/extract/${name}/`, import.meta.url);
  return [fs.readFileSync(new URL('a.ts', dir), 'utf8'), fs.readFileSync(new URL('b.ts', dir), 'utf8')] as const;
};
const extracts = async (name: string) => {
  const [a, b] = load(name);
  return (await semanticDiffFile('typescript', a, b)).semanticOperations.filter((o) => o.type === 'extractedFunction');
};

test('basic extract: loop pulled out into sumLineItems', async () => {
  const ops = await extracts('basic');
  assert.equal(ops.length, 1);
  const op = ops[0]!;
  assert.deepEqual(op.spans.map((s) => `${s.role}/${s.relation}`), ['body/moved', 'call/introduced', 'focus/introduced', 'container/introduced']);
  // The moved body pairs old lines 2-5 with new lines 7-10.
  const body = op.spans[0]!;
  assert.ok(body.relation === 'moved');
  assert.deepEqual(body.linePairs, [{ old: { start: 2, end: 5 }, new: { start: 7, end: 11 } }]);
});

test('extract with edits inside (a parameter added, a condition changed)', async () => {
  assert.equal((await extracts('edited')).length, 1);
});

test('partial extract: three checks moved out, one new check added', async () => {
  assert.equal((await extracts('partial')).length, 1);
});

test('an unrelated new function is not an extract', async () => {
  assert.equal((await extracts('unrelated')).length, 0);
});

test('a function that only moved is not an extract', async () => {
  assert.equal((await extracts('moved')).length, 0);
});

test('extract called from two places (duplicated code pulled into one helper)', async () => {
  const a = `class G {
  arrange(focused: Element) {
    this.layout();
    if (focused.isConnected && this.root.contains(focused)) {
      focused.focus();
    }
    this.paint();
  }
}
`;
  const b = `class G {
  arrange(focused: Element) {
    this.layout();
    this.restoreFocus(focused);
    this.paint();
    this.restoreFocus(focused);
  }

  private restoreFocus(focused: Element): void {
    if (focused.isConnected && this.root.contains(focused)) {
      focused.focus();
    }
  }
}
`;
  const ops = (await semanticDiffFile('typescript', a, b)).semanticOperations.filter((o) => o.type === 'extractedFunction');
  assert.equal(ops.length, 1);
  const call = ops[0]!.spans.find((s) => s.role === 'call');
  assert.ok(call && call.relation === 'introduced' && call.new.length === 2, 'both call sites are marked');
});

test('extract whose returned value was edited on the way (wrapped in another call)', async () => {
  const a = `function toPlainLabel(value: string): string {
  const singleLine = value.replace(/[\\u0000-\\u001f]+/g, ' ').replace(/\\]\\(/g, '] (');
  return singleLine.trim();
}
`;
  const b = `function toPlainLabel(value: string): string {
  const singleLine = toPlainText(value);
  return singleLine.trim();
}

function toPlainText(value: string): string {
  return escapeIcons(value.replace(/[\\u0000-\\u001f]+/g, ' ').replace(/\\]\\(/g, '] ('));
}
`;
  const ops = (await semanticDiffFile('typescript', a, b)).semanticOperations.filter((o) => o.type === 'extractedFunction');
  assert.equal(ops.length, 1);
});

test('a new one-line accessor that only resembles old code is not an extract', async () => {
  const a = `class S {
  open() {
    const active = this.visibility.activeSession.get();
    return active;
  }
}
`;
  const b = `class S {
  open() {
    const active = this.activeGridSession();
    return active;
  }

  private activeGridSession() {
    return this.visibility.activePane.read()?.session.read();
  }
}
`;
  const ops = (await semanticDiffFile('typescript', a, b)).semanticOperations.filter((o) => o.type === 'extractedFunction');
  assert.equal(ops.length, 0);
});

test("VS Code fixture difficult-move: the docker block is extracted into extractAlpinefromDocker", async () => {
  const dir = new URL('./fixtures/vscode/difficult-move/', import.meta.url);
  const ops = (await semanticDiffFile('typescript', fs.readFileSync(new URL('1.js', dir), 'utf8'), fs.readFileSync(new URL('2.js', dir), 'utf8'))).semanticOperations;
  const ex = ops.filter((o) => o.type === 'extractedFunction');
  assert.equal(ex.length, 1);
  // VS Code reports old lines [223, 226) moving to [158, 161).
  const body = ex[0]!.spans[0]!;
  assert.ok(body.relation === 'moved');
  assert.ok(body.linePairs.some((p) => p.old.start <= 223 && p.old.end >= 225 && p.new.start <= 158 && p.new.end >= 160), JSON.stringify(body.linePairs));
});
