/**
 * The connect snippets are commands a person pastes into a shell or a config
 * file. Whatever path the CLI lives at (spaces, quotes, non-ASCII), each must
 * come back as exactly that path: a wrong quote is a command that fails on
 * someone's machine with nothing on screen to say why.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fc from 'fast-check';
import { cursorInstallLink, gooseInstallLink, harnessPanel, HARNESSES, shellLine, shellWord, vscodeInstallLink, type ConnectContext } from './harnesses';

const ctx = (binary: string): ConnectContext => ({ command: [binary, 'inbox', 'mcp'], mcpUrl: 'http://127.0.0.1:52817/mcp', platform: 'mac' });

describe('connect snippets', () => {
  test.skipIf(process.platform === 'win32')('a quoted word reads back as the same word in a POSIX shell, for any text', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40, unit: 'grapheme' }).filter((s) => !s.includes('\0')), (word) => {
        const out = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellWord(word)}`], { encoding: 'utf8' });
        expect(out.stdout).toBe(word);
      }),
      { numRuns: 60 },
    );
  });

  test('a path with spaces stays one word in every command line', () => {
    expect(shellLine(['/Users/a b/.local/bin/plannotator', 'inbox', 'mcp'])).toBe("'/Users/a b/.local/bin/plannotator' inbox mcp");
  });

  test('the install links carry the exact command and arguments', () => {
    const binary = '/Users/a b/.local/bin/plannotator';
    const cursor = new URL(cursorInstallLink(ctx(binary)));
    expect(cursor.searchParams.get('name')).toBe('plannotator-inbox');
    expect(JSON.parse(Buffer.from(cursor.searchParams.get('config')!, 'base64').toString('utf8'))).toEqual({ command: binary, args: ['inbox', 'mcp'] });
    const vscode = vscodeInstallLink(ctx(binary));
    expect(JSON.parse(decodeURIComponent(vscode.slice('vscode:mcp/install?'.length)))).toEqual({ name: 'plannotator-inbox', type: 'stdio', command: binary, args: ['inbox', 'mcp'] });
    const goose = new URL(gooseInstallLink(ctx(binary)));
    expect(goose.searchParams.get('cmd')).toBe(binary);
    expect(goose.searchParams.getAll('arg')).toEqual(['inbox', 'mcp']);
  });

  test('every harness has a panel, and every JSON snippet parses', () => {
    for (const harness of HARNESSES) {
      const panel = harnessPanel(harness.id, ctx('/opt/plannotator'));
      expect(panel.artefacts.length).toBeGreaterThan(0);
      for (const artefact of [...panel.artefacts, ...(panel.another?.body ? [panel.another.body] : [])]) {
        if (artefact.kind === 'code' && artefact.text.trimStart().startsWith('{')) expect(() => JSON.parse(artefact.text)).not.toThrow();
      }
    }
  });
});
