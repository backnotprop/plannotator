import { describe, expect, test } from 'bun:test'
import {
  parsePlannotatorToolInput,
  plannotatorCommandToToolInput as take,
  simpleShellCommandWords,
} from './plannotator-tool'

// The failure these guard: a host answers an agent's shell command itself, so
// a command taken over that should have run (a strict gate, a pipeline, a flag
// the tool cannot carry) silently changes what the agent asked for, and a
// command passed through that could have been taken over blocks the session
// and gives Ask AI a separate AI instead of the session.

function expectPassThrough(commands: string[]): void {
  for (const command of commands) {
    // The command rides along so a failure names it.
    expect([command, take(command)]).toEqual([command, null])
  }
}

describe('plannotatorCommandToToolInput: taken over', () => {
  test('annotate, with the flags the tool carries', () => {
    expect(take('plannotator annotate notes.md')).toEqual({ action: 'annotate', target: 'notes.md' })
    expect(take('plannotator annotate /tmp/INDEX.html --gate --json')).toEqual({ action: 'annotate', target: '/tmp/INDEX.html', gate: true })
    expect(take('plannotator annotate --gate --json REVIEW-3.md')).toEqual({ action: 'annotate', target: 'REVIEW-3.md', gate: true })
    expect(take('plannotator annotate page.html --markdown')).toEqual({ action: 'annotate', target: 'page.html', options: { markdown: true } })
    expect(take('plannotator annotate https://example.com/docs')).toEqual({ action: 'annotate', target: 'https://example.com/docs' })
    expect(take('plannotator annotate docs/')).toEqual({ action: 'annotate', target: 'docs/' })
  })

  test('review, with an optional target and --base', () => {
    expect(take('plannotator review')).toEqual({ action: 'review' })
    expect(take('plannotator review --json')).toEqual({ action: 'review' })
    expect(take('plannotator review https://github.com/o/r/pull/7')).toEqual({ action: 'review', target: 'https://github.com/o/r/pull/7' })
    expect(take('plannotator review --base main ../wt')).toEqual({ action: 'review', target: '../wt', options: { base: 'main' } })
    expect(take('plannotator review ../wt --base origin/feature/x')).toEqual({ action: 'review', target: '../wt', options: { base: 'origin/feature/x' } })
  })

  test('last and annotate-last', () => {
    expect(take('plannotator last')).toEqual({ action: 'last' })
    expect(take('plannotator annotate-last')).toEqual({ action: 'last' })
    expect(take('plannotator annotate-last --json')).toEqual({ action: 'last' })
  })

  test('several file paths become one review of several files, in order', () => {
    expect(take('plannotator annotate spec.md mock.html notes.md')).toEqual({ action: 'annotate', target: ['spec.md', 'mock.html', 'notes.md'] })
    expect(take('plannotator annotate docs/a ~/b.md @c.md --gate --json')).toEqual({ action: 'annotate', target: ['docs/a', '~/b.md', '@c.md'], gate: true })
    // An exact duplicate collapses; one path left is a plain target.
    expect(take('plannotator annotate a.md a.md')).toEqual({ action: 'annotate', target: 'a.md' })
  })

  test('surrounding whitespace is ignored', () => {
    expect(take('  plannotator   annotate\ta.md  \n')).toEqual({ action: 'annotate', target: 'a.md' })
  })

  test('quoting yields the word the program would receive', () => {
    expect(take('plannotator annotate "docs/my notes.md" --gate')).toEqual({ action: 'annotate', target: 'docs/my notes.md', gate: true })
    expect(take("plannotator annotate 'it''s.md'")).toEqual({ action: 'annotate', target: 'its.md' })
    expect(take('plannotator annotate my\\ notes.md')).toEqual({ action: 'annotate', target: 'my notes.md' })
    expect(take("plannotator annotate '$HOME/a.md'")).toEqual({ action: 'annotate', target: '$HOME/a.md' })
    expect(take('plannotator annotate ~/notes.md')).toEqual({ action: 'annotate', target: '~/notes.md' })
  })

  test('every take-over is a valid tool call', () => {
    for (const command of ['plannotator annotate a.md --gate --markdown', 'plannotator review --base main x', 'plannotator last']) {
      expect(parsePlannotatorToolInput(take(command)).ok).toBe(true)
    }
  })
})

describe('plannotatorCommandToToolInput: passed through', () => {
  test('strict gates and flags the tool cannot carry keep the real CLI', () => {
    expectPassThrough([
      'plannotator annotate a.md --gate --json --require-approval',
      'plannotator annotate a.md --gate --json --result-file out.json',
      'plannotator annotate a.md --hook',
      'plannotator annotate a.md --tailscale',
      'plannotator review --tailscale',
      'plannotator annotate http://localhost:5173 --static',
      'plannotator annotate http://localhost:5173 --app',
      'plannotator annotate https://example.com --no-jina',
      'plannotator annotate a.md --render-html',
      'plannotator annotate --help',
      'plannotator review --help',
      'plannotator review -h',
      'plannotator review --diff-type staged',
      'plannotator review --local https://github.com/o/r/pull/7',
      'plannotator review --patch-file x.patch',
      'plannotator review --gate',
      'plannotator review --markdown',
      'plannotator annotate a.md --base main',
      'plannotator last --gate',
      'plannotator annotate-last --stdin',
      'plannotator annotate a.md --gate --gate',
      'plannotator review --base main --base dev',
      'plannotator review --base',
      'plannotator review --base --json',
      'plannotator annotate a.md --',
    ])
  })

  test('other programs, subcommands and argument shapes keep the real CLI', () => {
    expectPassThrough([
      '',
      'plannotator',
      'plannotator archive',
      'plannotator guide export --id x',
      'plannotator claude-mod-plan',
      'plannotator --version',
      'plannotator annotate',
      // Several targets that are not all file paths: the CLI's tolerant
      // resolution reads the prose, so the command runs as written.
      'plannotator annotate look at notes.md please',
      'plannotator annotate notes.md https://example.com',
      'plannotator review a.md b.md',
      'plannotator review ../a ../b',
      'plannotator last extra',
      'plannotatorx annotate a.md',
      // A path is a dev build (or a binary other than the installed one): it runs for real.
      './plannotator review',
      '/tmp/dev/plannotator annotate x.md',
      '~/.local/bin/plannotator annotate a.md',
      'npx plannotator annotate a.md',
      'bunx plannotator review',
      'echo plannotator annotate a.md',
      'PLANNOTATOR_ORIGIN=pi plannotator annotate a.md',
      'env plannotator annotate a.md',
    ])
  })

  test('any shell syntax keeps the real CLI', () => {
    expectPassThrough([
      'cd docs && plannotator annotate a.md',
      'plannotator annotate a.md && echo done',
      'plannotator annotate a.md || true',
      'plannotator annotate a.md; ls',
      'plannotator annotate a.md | cat',
      'plannotator annotate a.md > out.txt',
      'plannotator annotate a.md 2>&1',
      'plannotator annotate a.md &',
      'plannotator annotate < a.md',
      'plannotator annotate $FILE',
      'plannotator annotate "$FILE"',
      'plannotator annotate ${FILE}',
      'plannotator annotate $(ls *.md | head -1)',
      'plannotator annotate `ls`',
      'plannotator annotate "a`x`.md"',
      'plannotator annotate *.md',
      'plannotator annotate notes?.md',
      'plannotator annotate notes[1].md',
      'plannotator annotate {a,b}.md',
      'plannotator annotate a.md # look',
      'plannotator annotate ~other/a.md',
      'plannotator annotate a.md\nplannotator review',
      'plannotator annotate \\\na.md',
      '(plannotator annotate a.md)',
      'plannotator annotate "unterminated.md',
      "plannotator annotate 'unterminated.md",
    ])
  })

  test('targets the tool itself would refuse are not taken over', () => {
    expectPassThrough(['plannotator annotate " "', 'plannotator review --base "a b"', 'plannotator annotate "a.md\tb"'])
  })
})

describe('simpleShellCommandWords', () => {
  test('splits a simple command into the words a shell would pass', () => {
    expect(simpleShellCommandWords(`a "b c" 'd' e\\ f`)).toEqual(['a', 'b c', 'd', 'e f'])
    expect(simpleShellCommandWords('a "x\\"y" "\\$z"')).toEqual(['a', 'x"y', '$z'])
    expect(simpleShellCommandWords('a b#c ~ ~/x ""')).toEqual(['a', 'b#c', '~', '~/x', ''])
  })
})
