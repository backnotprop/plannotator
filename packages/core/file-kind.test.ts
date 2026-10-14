import { describe, expect, test } from 'bun:test';
import { fileKind, groupByFileKind, isDefaultGeneratedPath, isTestPath } from './file-kind';

describe('isTestPath', () => {
  test.each([
    // JS / TS
    'src/retry.test.ts',
    'src/Button.spec.tsx',
    'src/sync/__tests__/client.ts',
    'src/__mocks__/fs.ts',
    'src/components/__snapshots__/Button.test.tsx.snap',
    'src/Button.stories.tsx',
    'src/__fixtures__/user.json',
    'tests/e2e/sync.spec.ts',
    'e2e/login.ts',
    'test/helpers.js',
    // Go
    'pkg/server/handler_test.go',
    'internal/testdata/golden.txt',
    // Python
    'app/tests/test_models.py',
    'test_utils.py',
    'utils_test.py',
    // Rust
    'crates/core/tests/integration.rs',
    // Java / Kotlin
    'src/test/java/com/acme/AppTest.java',
    // Ruby
    'spec/models/user_spec.rb',
    // Swift (capitalized folder)
    'Tests/AppTests/AppTests.swift',
    // fixtures anywhere
    'packages/core/fixtures/guide.json',
    // pytest and Django
    'app/conftest.py',
    'polls/tests.py',
    // Cypress, e2e and tsd type tests
    'cypress/login.cy.ts',
    'src/app.e2e.ts',
    'src/types.test-d.ts',
    // Gradle / Kotlin source sets and test fixtures
    'app/src/androidTest/kotlin/MainTest.kt',
    'shared/src/commonTest/kotlin/Sync.kt',
    'service/src/integrationTest/java/ApiIT.java',
    'lib/src/testFixtures/java/Builders.java',
    // .NET test projects
    'Acme.Tests/OrderTests.cs',
    'src/Acme.UnitTests/Fakes.cs',
  ])('%s is a test', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  test.each([
    'src/contest.ts',
    'src/latest.ts',
    'testing-library.config.js',
    'jest.config.js',
    'vitest.setup.ts',
    'src/test.ts',
    'src/testing/render.ts',
    'src/attestation.ts',
    'src/specs.md',
    'docs/spec.md',
    'src/protest_test',
    'scripts/testify.sh',
    'src/test_helpers.ts',
    'README.md',
    '.github/workflows/test.yml',
    'src/contest/score.ts',
    'src/latest_test',
    '.test.ts',
    // a test marker before a non-code extension
    'openapi.spec.yaml',
    'contracts/payment.spec.json',
    'scripts/load_test.md',
    'docs/api.test.html',
    // source-set shape only directly under src; .NET shape needs a dot
    'src/main/kotlin/LatestTest/Foo.kt',
    'app/main/androidTest/Foo.kt',
    'Tests.Shared/Helpers.cs',
    'src/AcmeTests/Helpers.cs',
    'src/settings.py',
  ])('%s is not a test', (path) => {
    expect(isTestPath(path)).toBe(false);
  });
});

describe('fileKind', () => {
  test('built-in generated names without a host set', () => {
    expect(fileKind('bun.lock')).toBe('generated');
    expect(fileKind('web/dist/app.min.js')).toBe('generated');
    expect(fileKind('Cargo.lock')).toBe('generated');
    expect(isDefaultGeneratedPath('.min.js')).toBe(false);
  });

  test("the host's generated set decides when given, in both directions", () => {
    const generated = new Set(['src/schema.gen.ts']);
    expect(fileKind('src/schema.gen.ts', generated)).toBe('generated');
    // .gitattributes un-marked a lockfile: the host set leaves it out.
    expect(fileKind('bun.lock', generated)).toBe('code');
  });

  test('generated wins over tests, tests over code; docs and config are code', () => {
    expect(fileKind('tests/fixtures/data.min.js')).toBe('generated');
    expect(fileKind('src/a.test.ts')).toBe('test');
    expect(fileKind('package.json')).toBe('code');
    expect(fileKind('docs/sync.md')).toBe('code');
    expect(fileKind('.github/workflows/ci.yml')).toBe('code');
  });
});

describe('groupByFileKind', () => {
  test('code, tests, generated; items keep their order inside a kind; empty kinds left out', () => {
    const paths = ['bun.lock', 'src/b.test.ts', 'src/z.ts', 'src/a.test.ts', 'src/a.ts'];
    const groups = groupByFileKind(paths, (p) => p);
    expect(groups.map((g) => g.kind)).toEqual(['code', 'test', 'generated']);
    expect(groups[0].items).toEqual(['src/z.ts', 'src/a.ts']);
    expect(groups[1].items).toEqual(['src/b.test.ts', 'src/a.test.ts']);
    expect(groupByFileKind(['a.ts', 'b.ts'], (p) => p).map((g) => g.kind)).toEqual(['code']);
  });
});
