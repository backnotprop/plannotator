import { describe, test, expect } from 'bun:test';
import {
  isCodeFilePath,
  isCodeFilePathStrict,
  isPlausibleCodeFilePath,
  CODE_PATH_BARE_REGEX,
} from './code-file';

describe('isCodeFilePath', () => {
  test('matches common extensions', () => {
    expect(isCodeFilePath('button.tsx')).toBe(true);
    expect(isCodeFilePath('utils.ts')).toBe(true);
    expect(isCodeFilePath('main.py')).toBe(true);
    expect(isCodeFilePath('lib.rs')).toBe(true);
    expect(isCodeFilePath('config.json')).toBe(true);
    expect(isCodeFilePath('styles.css')).toBe(true);
  });

  test('matches paths with directories', () => {
    expect(isCodeFilePath('src/components/Button.tsx')).toBe(true);
    expect(isCodeFilePath('./utils/helpers.ts')).toBe(true);
    expect(isCodeFilePath('../lib/main.py')).toBe(true);
  });

  test('matches special filenames', () => {
    expect(isCodeFilePath('Dockerfile')).toBe(true);
    expect(isCodeFilePath('Makefile')).toBe(true);
    expect(isCodeFilePath('path/to/Dockerfile')).toBe(true);
  });

  test('strips hash fragments', () => {
    expect(isCodeFilePath('src/foo.ts#L42')).toBe(true);
  });

  test('rejects URLs', () => {
    expect(isCodeFilePath('https://github.com/foo.ts')).toBe(false);
    expect(isCodeFilePath('http://example.com/main.py')).toBe(false);
  });

  test('rejects non-code files', () => {
    expect(isCodeFilePath('.env')).toBe(false);
    expect(isCodeFilePath('readme.txt')).toBe(false);
    expect(isCodeFilePath('npm install')).toBe(false);
  });
});

describe('isCodeFilePathStrict', () => {
  test('requires a / separator', () => {
    expect(isCodeFilePathStrict('button.tsx')).toBe(false);
    expect(isCodeFilePathStrict('Dockerfile')).toBe(false);
    expect(isCodeFilePathStrict('package.json')).toBe(false);
  });

  test('matches paths with directories', () => {
    expect(isCodeFilePathStrict('src/components/Button.tsx')).toBe(true);
    expect(isCodeFilePathStrict('./utils/helpers.ts')).toBe(true);
    expect(isCodeFilePathStrict('../lib/main.py')).toBe(true);
    expect(isCodeFilePathStrict('path/to/Makefile')).toBe(true);
  });

  test('rejects URLs even with /', () => {
    expect(isCodeFilePathStrict('https://github.com/foo.ts')).toBe(false);
  });

  test('rejects non-code paths with /', () => {
    expect(isCodeFilePathStrict('path/to/readme.txt')).toBe(false);
    expect(isCodeFilePathStrict('some/dir/.env')).toBe(false);
  });

  test('rejects shape-implausible bare prose', () => {
    expect(isCodeFilePathStrict('packages/ui/{a,b}.ts')).toBe(false);
  });
});

describe('isPlausibleCodeFilePath', () => {
  test('accepts plain code paths', () => {
    expect(isPlausibleCodeFilePath('packages/editor/App.tsx')).toBe(true);
    expect(isPlausibleCodeFilePath('foo.ts')).toBe(true);
  });

  test('accepts Next.js dynamic routes', () => {
    expect(isPlausibleCodeFilePath('app/[slug]/page.tsx')).toBe(true);
    expect(isPlausibleCodeFilePath('app/[...rest]/page.tsx')).toBe(true);
  });

  test('rejects shell brace expansion', () => {
    expect(isPlausibleCodeFilePath('packages/ui/{a,b,c}.ts')).toBe(false);
  });

  test('rejects glob wildcards', () => {
    expect(isPlausibleCodeFilePath('src/*.ts')).toBe(false);
    expect(isPlausibleCodeFilePath('src/foo?.ts')).toBe(false);
  });

  test('rejects whitespace', () => {
    expect(isPlausibleCodeFilePath('path with space.ts')).toBe(false);
  });
});

describe('CODE_PATH_BARE_REGEX', () => {
  test('matches abbreviated paths', () => {
    const re = new RegExp(CODE_PATH_BARE_REGEX.source, 'g');
    const m = 'see editor/App.tsx for details'.match(re);
    expect(m).toContain('editor/App.tsx');
  });

  test('matches Next.js dynamic-route paths', () => {
    const re = new RegExp(CODE_PATH_BARE_REGEX.source, 'g');
    const m = 'visit app/[slug]/page.tsx'.match(re);
    expect(m).toContain('app/[slug]/page.tsx');
  });
});
