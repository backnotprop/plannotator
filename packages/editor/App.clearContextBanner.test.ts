import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('App clear-context approval UI', () => {
  test('does not render the blocking native clear-on-accept prompt', () => {
    const source = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8');

    expect(source).not.toContain('showClearContextBanner');
    expect(source).not.toContain('Enable native clear-on-accept?');
    expect(source).not.toContain('aria-label="Enable native clear-on-accept"');
  });

  test('gates the native clear setup API behind the shared native-clear predicate', () => {
    const source = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8');

    expect(source.match(/\/api\/enable-clear-context/g)?.length).toBe(1);
    expect(source).toContain('shouldEnableNativeClearBeforeApprove({ origin, permissionMode, toolName: pendingToolName, override })');
    expect(source).toContain("clearContextNudge: true");
  });
});
