import { describe, expect, test } from 'bun:test';
import { formatCallFlowInstallSize } from './callFlowPresentation';

describe('formatCallFlowInstallSize', () => {
  test('rounds bytes up to whole megabytes', () => {
    expect(formatCallFlowInstallSize(7 * 1024 * 1024)).toBe('~7 MB');
    expect(formatCallFlowInstallSize(7 * 1024 * 1024 + 1)).toBe('~8 MB');
    expect(formatCallFlowInstallSize(1)).toBe('~1 MB');
  });
});
