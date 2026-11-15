import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageForPath, semanticDiffFile } from '../src/index.ts';

const ops = async (a: string, b: string) =>
  (await semanticDiffFile('ruby', a, b, 'x.rb')).semanticOperations.map((o) => [o.type, o.lines.old.map((l) => [l.start, l.end]), o.lines.new.map((l) => [l.start, l.end])]);
const types = async (a: string, b: string) => (await ops(a, b)).map((o) => o[0]);

test('Ruby files are read; ERB templates are not', () => {
  assert.equal(languageForPath('lib/cart.rb'), 'ruby');
  assert.equal(languageForPath('lib/tasks/db.rake'), 'ruby');
  assert.equal(languageForPath('shop.gemspec'), 'ruby');
  assert.equal(languageForPath('Rakefile'), 'ruby');
  assert.equal(languageForPath('app/Gemfile'), 'ruby');
  assert.equal(languageForPath('app/views/index.html.erb'), null);
});

test('a constant whose heredoc follows it moves with its text', async () => {
  const a = 'class Q\n  A = <<~SQL\n    select 1\n    from t\n  SQL\n\n  def x\n    1\n  end\n\n  def y\n    2\n  end\nend\n';
  const b = 'class Q\n  def x\n    1\n  end\n\n  def y\n    2\n  end\n\n  A = <<~SQL\n    select 1\n    from t\n  SQL\nend\n';
  assert.deepEqual(await ops(a, b), [['moved', [[2, 5]], [[10, 13]]]]);
});

test('a changed heredoc text is never formatting', async () => {
  const a = 'class Q\n  A = <<~SQL\n    select 1\n  SQL\nend\n';
  const b = 'class Q\n  A = <<~SQL\n    select  1\n  SQL\nend\n';
  assert.ok(!(await types(a, b)).includes('reformatted'));
});

test('a method moved into class << self is not a move', async () => {
  const a = 'class A\n  def build\n    new\n  end\n\n  class << self\n    def other\n      1\n    end\n  end\nend\n';
  const b = 'class A\n  class << self\n    def other\n      1\n    end\n\n    def build\n      new\n    end\n  end\nend\n';
  const t = await types(a, b);
  assert.ok(!t.includes('moved') && !t.includes('movedWithEdit'), t.join());
});

test('a private line moved across a method is an edit, not a move', async () => {
  const a = 'class A\n  def a\n    1\n  end\n\n  private\n\n  def b\n    2\n  end\n\n  def c\n    3\n  end\nend\n';
  const b = 'class A\n  def a\n    1\n  end\n\n  def b\n    2\n  end\n\n  private\n\n  def c\n    3\n  end\nend\n';
  const t = await types(a, b);
  assert.ok(!t.includes('moved') && !t.includes('movedWithEdit'), t.join());
});

test('protected becoming private is an edit', async () => {
  const t = await types('class A\n  def a; 1; end\n  protected\n  def b; 2; end\nend\n', 'class A\n  def a; 1; end\n  private\n  def b; 2; end\nend\n');
  assert.deepEqual(t, ['edited']);
});

test('requires re-sorted are moves; an attr line that changed is an edit', async () => {
  assert.deepEqual(await types('require "b"\nrequire "a"\n', 'require "a"\nrequire "b"\n'), ['moved']);
  assert.deepEqual(await types('class A\n  attr_reader :b, :a\nend\n', 'class A\n  attr_reader :a, :b, :c\nend\n'), ['edited']);
});

test('a method renamed with its bare calls is one rename', async () => {
  const a = 'class A\n  def subtotal\n    items.sum(&:price)\n  end\n\n  def total\n    subtotal * 2 + subtotal\n  end\nend\n';
  const b = a.replaceAll('subtotal', 'net');
  assert.deepEqual(await types(a, b), ['renamed']);
});

test('a bare name that is a local variable is not a call', async () => {
  const a = 'class R\n  def render\n    header = 1\n    lines = []\n    lines << header\n    lines << "=" * 20\n    lines.join\n  end\n\n  def header\n    "h"\n  end\nend\n';
  const b = 'class R\n  def render\n    header = 1\n    lines = []\n    lines << header\n    lines.join\n  end\n\n  def header\n    "h"\n  end\nend\n';
  const t = await types(a, b);
  assert.ok(!t.includes('inlinedFunction') && !t.includes('extractedFunction'), t.join());
});

test("'e' and \"e\" are the same string; not when a double quote would read the text differently", async () => {
  const one = async (a: string, b: string) => types(`def f\n  x(${a})\nend\n`, `def f\n  x(${b})\nend\n`);
  assert.deepEqual(await one("'e'", '"e"'), ['reformatted']);
  assert.deepEqual(await one("'a#b'", '"a#b"'), ['edited']);
  assert.deepEqual(await one("'a\\\\n'", '"a\\\\n"'), ['edited']);
});

test('a method body re-indented into class << self is not formatting', async () => {
  const body = (pad: string) => ['@cache ||= {}', '', 'clean = if path.start_with?("~")', '  path.dup', 'else', '  path', 'end', '', 'File.expand_path(clean)'].map((l) => (l ? pad + l : l)).join('\n');
  const a = `class P\n  def self.clean(path)\n${body('    ')}\n  end\nend\n`;
  const b = `class P\n  class << self\n    def clean(path)\n${body('      ')}\n    end\n  end\nend\n`;
  const t = await types(a, b);
  assert.ok(!t.includes('reformatted') && !t.includes('moved'), t.join());
});

test('a method re-indented in place, same context, is still formatting', async () => {
  const a = 'class P\n  def clean(path)\n    x = 1\n    y = 2\n  end\nend\n';
  const b = 'class P\n  def clean(path)\n      x = 1\n      y = 2\n  end\nend\n';
  assert.deepEqual(await types(a, b), ['reformatted']);
});
