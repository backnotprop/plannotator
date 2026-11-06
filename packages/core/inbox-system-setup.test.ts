/**
 * System's setup contract: what the dialog and the server accept as a repo and a doc site, and the save's check.
 * What regresses: a pasted link or remote that names a repo refused, a non-repo or a non-web address taken, the
 * project's own repo or a duplicate saved twice, or a setup.json of another shape read as format 1.
 */
import { describe, expect, test } from 'bun:test';
import { parseSystemDocSite, parseSystemRepo, parseSystemSetup, systemAgentOfLaunch, systemSetupFromInput } from './inbox-system-setup';

test('launch agents map to setup.json names; one System does not run maps to none', () => {
  expect(systemAgentOfLaunch('claude-code')).toBe('claude');
  expect(systemAgentOfLaunch('pi')).toBe('pi');
  expect(systemAgentOfLaunch('opencode')).toBe('opencode');
  expect(systemAgentOfLaunch('dsh')).toBeNull();
});

const repo = (input: string, host?: string) => {
  const parsed = parseSystemRepo(input, host);
  return parsed.ok ? parsed.value : null;
};
const doc = (input: string) => {
  const parsed = parseSystemDocSite(input);
  return parsed.ok ? parsed.value : null;
};

describe('parseSystemRepo', () => {
  test('every way a person names a repo becomes host/owner/name', () => {
    expect(repo('acme/docs')).toBe('github.com/acme/docs');
    expect(repo('  acme/docs  ')).toBe('github.com/acme/docs');
    expect(repo('acme/docs', 'gitlab.com')).toBe('gitlab.com/acme/docs');
    expect(repo('gitlab.com/group/sub/project')).toBe('gitlab.com/group/sub/project');
    expect(repo('https://github.com/acme/docs')).toBe('github.com/acme/docs');
    expect(repo('https://github.com/acme/docs.git')).toBe('github.com/acme/docs');
    expect(repo('https://GitHub.com/acme/docs/tree/main/src')).toBe('github.com/acme/docs');
    expect(repo('https://gitlab.com/group/sub/project/-/tree/main')).toBe('gitlab.com/group/sub/project');
    expect(repo('git@github.com:acme/docs.git')).toBe('github.com/acme/docs');
    expect(repo('ssh://git@github.com:22/acme/docs.git')).toBe('github.com/acme/docs');
  });

  test('anything that is not a repo is refused with a reason', () => {
    for (const input of ['', '   ', 'docs', 'acme', 'acme/ docs', 'https://github.com/acme', 'acme/../etc', 'file:///etc/passwd', 'javascript:alert(1)', 'acme/do$cs']) {
      const parsed = parseSystemRepo(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });
});

describe('parseSystemDocSite', () => {
  test('a pasted address becomes a full https URL; a bare host gets https://', () => {
    expect(doc('help.example.com')).toBe('https://help.example.com/');
    expect(doc('https://help.example.com/guide/')).toBe('https://help.example.com/guide/');
    expect(doc('http://docs.example.org/a?b=1#top')).toBe('http://docs.example.org/a?b=1');
    expect(doc('localhost:3000/docs')).toBe('https://localhost:3000/docs');
  });

  test('not a web address: refused', () => {
    for (const input of ['', 'docs', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc', 'https://user:pw@example.com', 'two words.com', 'mailto:a@b.com']) {
      expect(parseSystemDocSite(input).ok).toBe(false);
    }
  });
});

describe('systemSetupFromInput', () => {
  const own = 'github.com/acme/app';

  test('normalizes, drops duplicates and the project\'s own repo, defaults the agent to Claude Code', () => {
    const checked = systemSetupFromInput(
      { repos: ['acme/app', 'acme/docs', 'https://github.com/ACME/docs', 'gitlab.com/x/y'], docs: ['help.example.com', 'https://help.example.com/'] },
      own,
    );
    expect(checked).toEqual({ ok: true, value: { repos: ['github.com/acme/docs', 'gitlab.com/x/y'], docs: ['https://help.example.com/'], agent: 'claude', model: 'claude-opus-5-5' } });
  });

  test('an entry that does not parse names its field; an unknown agent is refused', () => {
    const bad = systemSetupFromInput({ repos: ['acme'], docs: [] }, own);
    expect(bad.ok === false && bad.field).toBe('repos');
    const badDoc = systemSetupFromInput({ repos: [], docs: ['ftp://x.com'] }, own);
    expect(badDoc.ok === false && badDoc.field).toBe('docs');
    const notList = systemSetupFromInput({ repos: 'acme/docs' }, own);
    expect(notList.ok === false && notList.field).toBe('repos');
    const agent = systemSetupFromInput({ agent: 'codex' }, own);
    expect(agent.ok === false && agent.field).toBe('agent');
    expect(systemSetupFromInput({ agent: 'pi', model: null }, own)).toEqual({ ok: true, value: { repos: [], docs: [], agent: 'pi', model: null } });
    const model = systemSetupFromInput({ model: 'rm -rf' }, own);
    expect(model.ok === false && model.field).toBe('model');
  });
});

test('parseSystemSetup reads format 1 only', () => {
  const good = { v: 1, repos: ['github.com/a/b'], docs: [], agent: 'pi', model: 'claude-opus-5-5', thread_message: null };
  expect(parseSystemSetup(good)).toEqual(good);
  expect(parseSystemSetup({ ...good, model: undefined })).toEqual({ ...good, model: null });
  expect(parseSystemSetup({ ...good, model: 3 })).toBeNull();
  expect(parseSystemSetup({ ...good, v: 2 })).toBeNull();
  expect(parseSystemSetup({ ...good, agent: 'codex' })).toBeNull();
  expect(parseSystemSetup({ ...good, repos: [1] })).toBeNull();
  expect(parseSystemSetup({ ...good, thread_message: 5 })).toBeNull();
  expect(parseSystemSetup(null)).toBeNull();
});
