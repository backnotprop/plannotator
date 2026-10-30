/**
 * The repository label with the owner hidden. Guards the shapes
 * `parseRemoteUrl` hands over: a cut at the first slash would show a GitLab
 * subgroup instead of the project, and the folder-name fallback (no remote)
 * must never be emptied or cut.
 */
import { describe, expect, test } from 'bun:test';
import { repoLabel } from './repoLabel';

describe('repoLabel', () => {
  test('not hidden, the label is unchanged', () => {
    expect(repoLabel('acme/payments-service', false)).toBe('acme/payments-service');
  });

  test('hidden, owner/repo reads as the repository alone', () => {
    expect(repoLabel('acme/payments-service', true)).toBe('payments-service');
  });

  test('hidden, a GitLab subgroup path reads as its project, not the group', () => {
    expect(repoLabel('acme/platform/payments-service', true)).toBe('payments-service');
  });

  test('hidden, a folder name with no owner is left as it is', () => {
    expect(repoLabel('payments-service', true)).toBe('payments-service');
  });
});
