import { describe, expect, test } from 'bun:test';
import { agentModel, parseSetup, redrawCommand, unattendedDocs, unattendedDocUrl } from '../src/index.ts';

describe('agentModel', () => {
  test('Claude Code takes the id bare; Pi and OpenCode take provider/model', () => {
    expect(agentModel('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(agentModel('claude', 'anthropic/claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(agentModel('claude', 'opus')).toBe('opus');
    for (const agent of ['pi', 'opencode'] as const) {
      expect(agentModel(agent, 'claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
      expect(agentModel(agent, 'anthropic/claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
      expect(agentModel(agent, 'openrouter/anthropic/claude-opus-5-5')).toBe('openrouter/anthropic/claude-opus-5-5');
      expect(agentModel(agent, 'gpt-6-sol')).toBe('openai/gpt-6-sol');
      expect(agentModel(agent, 'o4-mini')).toBe('openai/o4-mini');
      expect(agentModel(agent, 'gemini-3-pro')).toBe('google/gemini-3-pro');
      // a family the package does not know is passed on for the agent to resolve
      expect(agentModel(agent, 'qwen3-coder')).toBe('qwen3-coder');
    }
  });

  test("null, empty or blank means the agent's own default", () => {
    for (const agent of ['claude', 'pi', 'opencode'] as const) {
      expect(agentModel(agent, null)).toBeNull();
      expect(agentModel(agent, '  ')).toBeNull();
    }
  });
});

describe('parseSetup', () => {
  const good = { v: 1, repos: ['github.com/acme/api'], docs: ['https://docs.example.com/'], agent: 'pi', model: 'claude-opus-5-5', thread_message: 'msg_1' };

  test("reads the Inbox's setup.json, ignoring keys a newer Inbox adds", () => {
    expect(parseSetup({ ...good, later: true })).toEqual(good as never);
    expect(parseSetup({ ...good, model: null, thread_message: null })?.model).toBeNull();
    expect(parseSetup({ v: 1, repos: [], docs: [], agent: 'opencode' })).toEqual({ v: 1, repos: [], docs: [], agent: 'opencode', model: null, thread_message: null });
  });

  test('refuses anything that is not a version 1 setup', () => {
    for (const bad of [null, [], 'x', { ...good, v: 2 }, { ...good, agent: 'codex' }, { ...good, repos: 'a' }, { ...good, docs: [1] }, { ...good, model: 5 }, { ...good, thread_message: {} }]) {
      expect(parseSetup(bad)).toBeNull();
    }
  });
});

describe('unattendedDocUrl', () => {
  test('a public https address is allowed', () => {
    for (const url of ['https://docs.example.com/guide', 'https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://docs.example.com:8443/']) {
      expect(unattendedDocUrl(url).ok).toBe(true);
    }
  });

  test('loopback and private IPs are refused in every spelling the URL parser takes', () => {
    const literals = [
      'https://127.0.0.1/', 'https://127.1/', 'https://0x7f.1/', 'https://2130706433/', 'https://0177.0.0.1/',
      'https://0.0.0.0/', 'https://10.1.2.3/', 'https://172.16.0.1/', 'https://172.31.255.255/', 'https://192.168.1.10/',
      'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/', 'https://224.0.0.1/', 'https://255.255.255.255/',
      'https://[::1]/', 'https://[::]/', 'https://[0:0:0:0:0:0:0:1]/', 'https://[fc00::1]/', 'https://[fd12:3456::1]/', 'https://[fe80::1]/',
      'https://[::ffff:127.0.0.1]/', 'https://[::ffff:10.0.0.1]/', 'https://[64:ff9b::7f00:1]/', 'https://[ff02::1]/',
    ];
    for (const url of literals) expect(unattendedDocUrl(url), url).toMatchObject({ ok: false, reason: 'a loopback, private or other non-public IP address' });
    // the edges stay public
    expect(unattendedDocUrl('https://172.32.0.1/').ok).toBe(true);
    expect(unattendedDocUrl('https://[::ffff:8.8.8.8]/').ok).toBe(true);
  });

  test('names for this computer or its network, sign-ins and anything but https are refused', () => {
    expect(unattendedDocUrl('http://docs.example.com/')).toMatchObject({ ok: false, reason: 'not https' });
    expect(unattendedDocUrl('ftp://docs.example.com/')).toMatchObject({ ok: false, reason: 'not https' });
    expect(unattendedDocUrl('file:///etc/passwd')).toMatchObject({ ok: false, reason: 'not https' });
    expect(unattendedDocUrl('https://maya:pw@docs.example.com/')).toMatchObject({ ok: false, reason: 'the address carries a sign-in' });
    for (const url of ['https://localhost/', 'https://docs.localhost/', 'https://printer.local/', 'https://intranet/']) {
      expect(unattendedDocUrl(url), url).toMatchObject({ ok: false, reason: 'a name for this computer or its local network' });
    }
    expect(unattendedDocUrl('not a url').ok).toBe(false);
  });

  test('unattendedDocs splits a setup into what the redraw may read and what it leaves out', () => {
    expect(unattendedDocs(['https://docs.example.com/', 'https://127.0.0.1:3000/', 'http://docs.example.org/'])).toEqual({
      allowed: ['https://docs.example.com/'],
      refused: [
        { url: 'https://127.0.0.1:3000/', reason: 'a loopback, private or other non-public IP address' },
        { url: 'http://docs.example.org/', reason: 'not https' },
      ],
    });
  });
});

describe('redrawCommand', () => {
  test('Claude Code: headless with full tools, so nothing stops on a prompt; the model bare; the prompt on stdin', () => {
    const { command, stdin } = redrawCommand({ agent: 'claude', model: 'anthropic/claude-opus-5-5' }, 'PROMPT');
    expect(command).toEqual(['claude', '-p', '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--model', 'claude-opus-5-5']);
    expect(stdin).toBe('PROMPT');
  });

  test('Pi and OpenCode get provider/model; OpenCode takes the prompt as its last argument', () => {
    expect(redrawCommand({ agent: 'pi', model: 'claude-opus-5-5' }, 'PROMPT')).toEqual({
      command: ['pi', '--no-session', '--model', 'anthropic/claude-opus-5-5', '-p'], stdin: 'PROMPT',
    });
    expect(redrawCommand({ agent: 'opencode', model: 'claude-opus-5-5' }, 'PROMPT')).toEqual({
      command: ['opencode', 'run', '--model', 'anthropic/claude-opus-5-5', 'PROMPT'], stdin: null,
    });
  });

  test("no model: the agent's own default, no --model", () => {
    for (const agent of ['claude', 'pi', 'opencode'] as const) expect(redrawCommand({ agent, model: null }, 'P').command).not.toContain('--model');
  });
});
