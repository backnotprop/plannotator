import { describe, expect, test } from 'bun:test';
import { askSessionSetupHint, OMP_EXTENSION_INSTALL_COMMAND } from './askSessionSetupHint';

const sdk = { name: 'claude-agent-sdk' };
const bridge = { name: 'session-bridge', sessionBridge: { host: 'pi', status: 'ready' as const, modes: { turn: true, transient: false } } };

describe('askSessionSetupHint (#1814)', () => {
  test('the CLI run from Oh My Pi (no bridge) names the OMP extension install command', () => {
    const hint = askSessionSetupHint('oh-my-pi', [sdk]);
    expect(hint).toContain(OMP_EXTENSION_INSTALL_COMMAND);
    // The command is what the user must run; pinned on purpose.
    expect(OMP_EXTENSION_INSTALL_COMMAND).toBe('omp plugin install @plannotator/pi-extension');
  });

  test('also with no providers at all, the state where Ask AI otherwise offers nothing', () => {
    expect(askSessionSetupHint('oh-my-pi', [])).toContain(OMP_EXTENSION_INSTALL_COMMAND);
  });

  test('a session that already has a bridge gets no hint', () => {
    expect(askSessionSetupHint('oh-my-pi', [bridge])).toBeNull();
  });

  test('other origins get no hint, bridge or not', () => {
    for (const origin of ['pi', 'claude-code', 'codex', 'opencode', null, undefined] as const) {
      expect(askSessionSetupHint(origin, [sdk])).toBeNull();
    }
  });
});
