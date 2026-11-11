import { expect, test } from 'bun:test';
import { parseRestartAgents, restartAgentsDescription, restartAgentsLabel, restartAgentsOf } from './restartAgents';

test('one runtime names itself; Oh My Pi restarts; more than one reads "Reload agents"', () => {
  expect(restartAgentsLabel({ total: 2, runtimes: { 'claude-code': 2 } })).toBe('Reload Claude Code');
  expect(restartAgentsLabel({ total: 1, runtimes: { pi: 1 } })).toBe('Reload Pi');
  expect(restartAgentsLabel({ total: 1, runtimes: { 'oh-my-pi': 1 } })).toBe('Restart Oh My Pi');
  expect(restartAgentsLabel({ total: 3, runtimes: { opencode: 3 } })).toBe('Reload OpenCode');
  expect(restartAgentsLabel({ total: 3, runtimes: { pi: 1, opencode: 2 } })).toBe('Reload agents');
});

test('the description names each runtime that waits; Claude Code alone keeps /reload-plugins', () => {
  expect(restartAgentsDescription({ total: 1, runtimes: { 'claude-code': 1 } })).toContain('/reload-plugins');
  const mixed = restartAgentsDescription({ total: 3, runtimes: { pi: 1, opencode: 2 } });
  expect(mixed).toContain('1 Pi session runs');
  expect(mixed).toContain('2 OpenCode sessions run');
  expect(mixed).not.toContain('/reload-plugins');
});

test('an older Inbox without restart_agents: its Claude Code count; a malformed field: no row', () => {
  expect(restartAgentsOf(undefined, 2)).toEqual({ total: 2, runtimes: { 'claude-code': 2 } });
  expect(restartAgentsOf(undefined, 0).total).toBe(0);
  expect(restartAgentsOf({ total: -1 }, 0).total).toBe(0);
  expect(parseRestartAgents('3')).toBeNull();
  expect(parseRestartAgents({ total: 2, runtimes: { pi: 2, codex: 4, opencode: 'x' } })).toEqual({ total: 2, runtimes: { pi: 2 } });
});

test('Claude Code sessions whose plugin on disk is behind: the row keeps that, and its description says to update the plugin first', () => {
  const behind = parseRestartAgents({ total: 2, runtimes: { 'claude-code': 2 }, update_first: 2 })!;
  expect(behind.update_first).toBe(2);
  expect(restartAgentsLabel(behind)).toBe('Reload Claude Code');
  const said = restartAgentsDescription(behind);
  expect(said.indexOf('update the plugin')).toBeGreaterThanOrEqual(0);
  expect(said.indexOf('update the plugin')).toBeLessThan(said.indexOf('/reload-plugins'));
  expect(restartAgentsDescription(parseRestartAgents({ total: 2, runtimes: { 'claude-code': 2 } })!)).not.toContain('update the plugin');
  expect(parseRestartAgents({ total: 1, runtimes: { 'claude-code': 1 }, update_first: 'x' })).toEqual({ total: 1, runtimes: { 'claude-code': 1 } });
});
