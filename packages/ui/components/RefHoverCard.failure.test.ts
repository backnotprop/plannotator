/**
 * The line a failed hover card shows when no tool problem is named. What this catches: a Forgejo card telling the
 * person "gh isn't installed" or to sign in to a CLI (it is read with an access token, never a CLI), and a Forgejo
 * failure that does not say where its token goes. GitHub and GitLab keep the CLI's line.
 */
import { describe, expect, test } from 'bun:test';
import type { ForgeRefCardError } from '@plannotator/core/forge-ref-card';
import { refFailureLine } from './RefHoverCard';

const ERRORS: ForgeRefCardError[] = ['unsupported', 'cli_missing', 'signed_out', 'not_found', 'rate_limited', 'unavailable'];

describe('refFailureLine for Forgejo', () => {
  test.each(ERRORS)('%s never names a CLI, and is the same whether or not the card got an answer', (error) => {
    const line = refFailureLine('forgejo', error, true);
    expect(line).not.toMatch(/\b(gh|glab|CLI)\b|Bitbucket|GitHub|GitLab/);
    expect(refFailureLine('forgejo', error, false)).toBe(line);
    expect(line.length).toBeGreaterThan(10);
  });

  test('an unnamed host says how to name it, and a refused token says where the token goes', () => {
    expect(refFailureLine('forgejo', 'unsupported', true)).toContain('forgejoHosts');
    expect(refFailureLine('forgejo', 'signed_out', true)).toContain('forgejoTokens');
  });
});

describe('refFailureLine for the other forges is unchanged', () => {
  test('Bitbucket keeps its own lines, with or without an answer', () => {
    expect(refFailureLine('bitbucket', 'unsupported', true)).toContain('Bitbucket Cloud');
    expect(refFailureLine('github', 'unsupported', false)).toContain('Bitbucket Cloud');
  });

  test('GitHub and GitLab keep the CLI they are read with', () => {
    expect(refFailureLine('github', 'unsupported', true)).toMatch(/\bgh\b|GitHub/);
    expect(refFailureLine('gitlab', 'unsupported', true)).toMatch(/\bglab\b|GitLab/);
    expect(refFailureLine('github', 'unsupported', true)).not.toBe(refFailureLine('gitlab', 'unsupported', true));
  });
});
