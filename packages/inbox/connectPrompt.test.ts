/**
 * The connect prompt names this computer's plannotator so an agent pasted it
 * can run every command without guessing PATH. What regresses: a path with
 * spaces left unquoted (the agent runs a different command), the trailing
 * `inbox mcp` kept (the agent runs `… inbox mcp inbox --help`), a step that
 * still names bare `plannotator` once the path is known, the fallback lost
 * before settings load, or the dropped step 6 (asking about the instructions
 * note, which the Inbox's own dialog does now) coming back.
 */
import { describe, expect, test } from 'bun:test';
import { connectCommand, connectPrompt } from './connectPrompt';

const BIN = '/Users/ada/.local/bin/plannotator';

describe('connectCommand', () => {
  test('strips the trailing inbox mcp from the settings command', () => {
    expect(connectCommand([BIN, 'inbox', 'mcp'])).toBe(BIN);
  });

  test('a dev run keeps every word before inbox mcp, quoted where a shell needs it', () => {
    expect(connectCommand(['/opt/bun', '/Users/a b/repo/apps/hook/server/index.ts', 'inbox', 'mcp'])).toBe(
      "/opt/bun '/Users/a b/repo/apps/hook/server/index.ts'",
    );
  });

  test('nothing loaded, or a command of another shape, is unknown', () => {
    expect(connectCommand(null)).toBeNull();
    expect(connectCommand(undefined)).toBeNull();
    expect(connectCommand([BIN])).toBeNull();
    expect(connectCommand([BIN, 'inbox', 'serve'])).toBeNull();
    expect(connectCommand(['', 'inbox', 'mcp'])).toBeNull();
  });
});

describe('connectPrompt', () => {
  test('with the settings loaded, every command names the absolute binary', () => {
    const text = connectPrompt([BIN, 'inbox', 'mcp']);
    expect(text).toContain(`Run Plannotator as: ${BIN}\n`);
    expect(text).toContain(`\`${BIN} inbox --help\``);
    expect(text).toContain(`\`${BIN} inbox mcp\``);
    // No command falls back to whatever `plannotator` the agent's PATH finds.
    expect(text).not.toMatch(/`plannotator /);
    expect(text).not.toContain('~/.local/bin/plannotator');
  });

  test('a path with a space is quoted inside every command', () => {
    const text = connectPrompt(['/Users/a b/bin/plannotator', 'inbox', 'mcp']);
    expect(text).toContain("`'/Users/a b/bin/plannotator' inbox --help`");
    expect(text).toContain("`'/Users/a b/bin/plannotator' inbox mcp`");
  });

  test('before the settings load it names bare plannotator and where it usually is', () => {
    const text = connectPrompt(null);
    expect(text).toContain('Run Plannotator as `plannotator`; if that is not found, use ~/.local/bin/plannotator');
    expect(text).toContain('%LOCALAPPDATA%\\plannotator\\plannotator.exe');
    expect(text).toContain('`plannotator inbox --help`');
    expect(text).toContain('`plannotator inbox mcp`');
  });

  test('five steps, numbered in order; the instructions-note step is gone', () => {
    const text = connectPrompt([BIN, 'inbox', 'mcp']);
    const steps = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5]);
    expect(text).not.toContain('instructions file');
    expect(text).toContain('"plannotator-inbox-connect-v1-<your host>"');
    expect(text).toContain(':::question\n   Want me to send some of our recent work here');
  });
});
