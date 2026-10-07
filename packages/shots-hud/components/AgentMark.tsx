/**
 * An agent's mark on its tile (Claude Code, Pi, OpenCode, Codex, …): the
 * destination chip and the picker say WHO with this instead of a word.
 * A waiting command shows the mark of the agent that ran it when known.
 */

import type { ConnectionHost } from '@plannotator/shared/shots/types';
import claude from '../assets/agents/claude.svg?raw';
import codex from '../assets/agents/codex.svg?raw';
import opencode from '../assets/agents/opencode.svg?raw';
import pi from '../assets/agents/pi.svg?raw';
import gemini from '../assets/agents/gemini.svg?raw';
import copilot from '../assets/agents/github-copilot.svg?raw';
import kiro from '../assets/agents/kiro.svg?raw';
import amp from '../assets/agents/amp.svg?raw';
import cursor from '../assets/agents/cursor.svg?raw';

const MARKS: Record<string, { svg: string; tile: string; label: string }> = {
  'claude-code': { svg: claude, tile: '#d97757', label: 'Claude Code' },
  pi: { svg: pi, tile: '#2f6f4f', label: 'Pi' },
  opencode: { svg: opencode, tile: '#3a3a40', label: 'OpenCode' },
  codex: { svg: codex, tile: '#111111', label: 'Codex' },
  'gemini-cli': { svg: gemini, tile: '#1f3b8a', label: 'Gemini' },
  'copilot-cli': { svg: copilot, tile: '#24292f', label: 'Copilot' },
  'kiro-cli': { svg: kiro, tile: '#4a2fbd', label: 'Kiro' },
  amp: { svg: amp, tile: '#f34e3f', label: 'Amp' },
  cursor: { svg: cursor, tile: '#111111', label: 'Cursor' },
};

const TERMINAL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6.5 8 3 11.5M8.5 11.5H13"/></svg>';

/** The mark for a connection: its host, or for a waiting command the agent named in its title ("codex · …"). */
export function markFor(host: ConnectionHost, title = ''): { svg: string; tile: string; label: string } {
  if (host !== 'cli-wait') return MARKS[host]!;
  const agent = title.split(' · ')[0]?.trim().toLowerCase() ?? '';
  return MARKS[agent] ?? { svg: TERMINAL, tile: '#1c1c1e', label: 'Waiting command' };
}

export function AgentMark({ host, title, size = 18 }: { host: ConnectionHost; title?: string; size?: number }) {
  const mark = markFor(host, title);
  return (
    <span
      className="agent-mark"
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: mark.tile }}
      dangerouslySetInnerHTML={{ __html: mark.svg }}
    />
  );
}
