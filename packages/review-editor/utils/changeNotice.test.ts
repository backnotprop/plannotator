import { describe, expect, test } from 'bun:test';
import { changeNotice } from './changeNotice';

describe('a change with no text to show says what it is, in one line', () => {
  test('a mode-only change, an empty new file and a retargeted symlink', () => {
    expect(changeNotice('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n')).toBe('Mode changed 100644 → 100755');
    expect(changeNotice('diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n')).toBe('Empty file');
    expect(changeNotice('diff --git a/current b/current\nindex 1111111..2222222 120000\n--- a/current\n+++ b/current\n@@ -1 +1 @@\n-releases/v1\n\\ No newline at end of file\n+releases/v2\n\\ No newline at end of file\n')).toBe('Symlink: releases/v1 → releases/v2');
  });

  test('an ordinary text change and a binary file get no notice', () => {
    expect(changeNotice('diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull();
    expect(changeNotice('diff --git a/a.png b/a.png\nindex 1..2 100644\nBinary files a/a.png and b/a.png differ\n')).toBeNull();
  });
});
