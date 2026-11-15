import { describe, expect, test } from 'bun:test';
import { fitBranch } from './BranchName';

const width = (text: string) => [...text].length * 7;

describe('a branch too long for the header', () => {
  test('keeps its start, one ellipsis and its last eight characters, never a cut letter', () => {
    const branch = 'feature/PLAT-12345/billing-reconciliation/v2-final';
    expect(fitBranch(branch, 1000, width)).toBe(branch);
    expect(fitBranch(branch, 140, width)).toBe('feature/PLA…v2-final');
    expect(fitBranch(branch, 63, width)).toBe('…v2-final');
    expect(fitBranch(branch, 40, width)).toBe('…inal');
  });
});
