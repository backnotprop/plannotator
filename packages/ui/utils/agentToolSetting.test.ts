/**
 * Reading the agent tool switch out of serverConfig and writing it back.
 * Guards: an older server, OpenCode 1 or a Workspaces host (no agentToolHost)
 * yielding a setting; a failed write resolving as if it saved; the offer
 * applying where it should not.
 */
import { describe, expect, test } from 'bun:test';
import { parseAgentToolSetting, saveAgentToolSetting } from './agentToolSetting';
import { agentToolAnnouncementEligible, agentToolOfferApplies, type AgentToolAnnouncementGateState } from './agentToolAnnouncement';

describe('parseAgentToolSetting', () => {
  test('reads the fields a tool host reports', () => {
    expect(parseAgentToolSetting({ agentToolHost: 'pi', agentToolEnabled: false, agentToolConfigured: false, agentTool: false }))
      .toEqual({ host: 'pi', enabled: false, configured: false });
    expect(parseAgentToolSetting({ agentToolHost: 'opencode', agentToolEnabled: true, agentToolConfigured: true, agentToolEnv: true }))
      .toEqual({ host: 'opencode', enabled: true, configured: true, env: true });
    // The Pi extension inside Oh My Pi reports its own host (on by default there).
    expect(parseAgentToolSetting({ agentToolHost: 'oh-my-pi', agentToolEnabled: true, agentToolConfigured: false, agentTool: true }))
      .toEqual({ host: 'oh-my-pi', enabled: true, configured: false });
  });

  test('nothing without a known tool host', () => {
    expect(parseAgentToolSetting(undefined)).toBeUndefined();
    expect(parseAgentToolSetting({})).toBeUndefined();
    // A saved value alone (a session whose host has no tool) is not a switch.
    expect(parseAgentToolSetting({ agentTool: true, agentToolConfigured: true })).toBeUndefined();
    expect(parseAgentToolSetting({ agentToolHost: 'codex', agentToolEnabled: false })).toBeUndefined();
    expect(parseAgentToolSetting({ agentToolHost: 'pi' })).toBeUndefined();
  });
});

describe('saveAgentToolSetting', () => {
  test('posts { agentTool } and resolves on ok', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await saveAgentToolSetting(true, (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch);
    expect(calls).toEqual([{ url: '/api/config', body: { agentTool: true } }]);
  });

  test('rejects with the server reason, or a status line, or a network note', async () => {
    const answer = (response: Response) => (async () => response) as unknown as typeof fetch;
    await expect(saveAgentToolSetting(true, answer(Response.json({ error: 'Could not save the setting to config.json.' }, { status: 500 }))))
      .rejects.toThrow('config.json');
    await expect(saveAgentToolSetting(true, answer(new Response('nope', { status: 403 })))).rejects.toThrow('403');
    await expect(saveAgentToolSetting(true, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch))
      .rejects.toThrow('Nothing was changed');
  });
});

describe('agent tool offer eligibility', () => {
  const base: AgentToolAnnouncementGateState = {
    announcementPending: true,
    isLoading: false,
    setting: { host: 'pi', enabled: false, configured: false },
    readOnlySession: false,
    compact: false,
    otherFirstRunDialogVisible: false,
    earlierAnnouncementMayShow: false,
  };

  test('Pi and OpenCode 2 with the tool off and unchosen', () => {
    expect(agentToolAnnouncementEligible(base)).toBe(true);
    expect(agentToolAnnouncementEligible({ ...base, setting: { host: 'opencode', enabled: false, configured: false } })).toBe(true);
  });

  test('not for Claude Code or Oh My Pi, an on, chosen or env-decided value, or no host', () => {
    for (const setting of [
      undefined,
      { host: 'claude-code', enabled: false, configured: false },
      // Oh My Pi has the tool on by default: nothing to offer, even if it reads off.
      { host: 'oh-my-pi', enabled: true, configured: false },
      { host: 'oh-my-pi', enabled: false, configured: false },
      { host: 'pi', enabled: true, configured: true },
      { host: 'pi', enabled: false, configured: true },
      { host: 'pi', enabled: false, configured: false, env: false },
    ] as const) {
      expect(agentToolOfferApplies(setting)).toBe(false);
    }
  });

  test('deferred behind loading, read-only, compact, another dialog, or an earlier announcement', () => {
    for (const patch of [
      { announcementPending: false },
      { isLoading: true },
      { readOnlySession: true },
      { compact: true },
      { otherFirstRunDialogVisible: true },
      { earlierAnnouncementMayShow: true },
    ]) {
      expect(agentToolAnnouncementEligible({ ...base, ...patch })).toBe(false);
    }
  });
});
