import { describe, expect, test } from 'bun:test';
import { fileStatusLetter } from '@plannotator/ui/utils/fileStatusLetter';

describe('one status vocabulary', () => {
  test('only additions and deletions spend colour; every letter is weight 500', () => {
    expect(fileStatusLetter('added').className).toContain('text-success');
    expect(fileStatusLetter('deleted').className).toContain('text-destructive');
    for (const status of ['modified', 'renamed', 'binary']) {
      expect(fileStatusLetter(status).className).toContain('text-muted-foreground');
    }
    expect(fileStatusLetter('added', { untracked: true }).letter).toBe('U');
    for (const status of ['added', 'deleted', 'modified', 'renamed']) {
      expect(fileStatusLetter(status).className).toContain('font-medium');
    }
  });
});
