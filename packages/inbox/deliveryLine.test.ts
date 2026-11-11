/**
 * The line under the person's last message (deliveryLine.ts). The failure
 * this catches: the owner's report, a reply to a working agent that read
 * "Saved for Claude Code. It sees it when it checks.", as if it were dropped
 * or the agent had to poll for it.
 */
import { describe, expect, test } from 'bun:test';
import { INBOX_SEND_NOW_SINCE } from '@plannotator/core/inbox-types';
import { deliveryLine, restartNote, sentRowLine, type DeliveryLineInput } from './deliveryLine';

const base: DeliveryLineInput = {
  name: 'Claude Code',
  deliveredAt: null,
  time: () => '5:12 PM',
  wakes: true,
  sendingNow: false,
  connection: undefined,
};

describe('the line under a sent reply', () => {
  test('a waking agent at work: queued until its turn ends, with Send now where its connection can take it', () => {
    expect(deliveryLine({ ...base, connection: { busy: true, idle_since: null, send_now: true } })).toEqual({
      state: 'queued',
      text: 'Queued · Claude Code is working; it gets this when its turn ends.',
      sendNow: true,
    });
    expect(deliveryLine({ ...base, connection: { busy: true, idle_since: null, send_now: false } }).sendNow).toBe(false);
  });

  test('idle: sending; after Send now: sending now; delivered: unchanged', () => {
    expect(deliveryLine({ ...base, connection: { busy: false, idle_since: '2026-10-16T17:00:00.000Z', send_now: true } })).toEqual({ state: 'sending', text: 'Sending to Claude Code…' });
    expect(deliveryLine({ ...base, sendingNow: true, connection: { busy: true, idle_since: null, send_now: true } })).toEqual({ state: 'sending', text: 'Sending to Claude Code now…' });
    expect(deliveryLine({ ...base, deliveredAt: '2026-10-16T17:12:00.000Z', connection: { busy: true, idle_since: null, send_now: true } })).toEqual({
      state: 'delivered',
      text: 'Delivered to Claude Code, 5:12 PM',
    });
  });

  test("pressed while the session cannot take it (its own Ask question holds it): queued, no second button", () => {
    expect(deliveryLine({ ...base, sendingNow: true, connection: { busy: true, idle_since: null, send_now: false } })).toEqual({
      state: 'queued',
      text: 'Queued · Claude Code is working; it gets this when its turn ends.',
      sendNow: false,
    });
  });

  test('not known yet, a connection that does not say, a session not connected now', () => {
    expect(deliveryLine(base).text).toBe('Queued for Claude Code; it gets this as its next turn.');
    expect(deliveryLine({ ...base, connection: { busy: null, idle_since: null, send_now: false } }).text).toBe('Queued for Claude Code; it gets this as its next turn.');
    expect(deliveryLine({ ...base, connection: null }).text).toBe('Queued for Claude Code; it gets this when its session is back.');
  });

  // Approval "inbox-stopped-reply": Claude Code refused the reply after the person stopped that session (#2780), and
  // takes nothing until they type there. "Sending" or "Queued" would promise a turn that is not coming.
  test('a session Claude Code holds until the person types: Stopped, whatever the turn state or Send now', () => {
    const stopped = { state: 'queued' as const, text: 'Stopped: goes in when you type in that session' };
    const idle = { busy: false, idle_since: '2026-10-16T17:00:00.000Z', send_now: true };
    expect(deliveryLine({ ...base, connection: { ...idle, held: true } })).toEqual(stopped);
    expect(deliveryLine({ ...base, sendingNow: true, connection: { ...idle, held: true } })).toEqual(stopped);
    expect(deliveryLine({ ...base, connection: { busy: null, idle_since: null, send_now: false, held: true } })).toEqual(stopped);
    // They typed and it went in: Delivered, not Stopped, even before the connection's next word clears the hold.
    expect(deliveryLine({ ...base, deliveredAt: '2026-10-16T17:12:00.000Z', connection: { ...idle, held: true } })).toEqual({
      state: 'delivered',
      text: 'Delivered to Claude Code, 5:12 PM',
    });
    // Not held: the ordinary words.
    expect(deliveryLine({ ...base, connection: { ...idle, held: false } }).text).toBe('Sending to Claude Code…');
    expect(deliveryLine({ ...base, connection: { busy: true, idle_since: null, send_now: false } }).text).toBe('Queued · Claude Code is working; it gets this when its turn ends.');
    expect(deliveryLine({ ...base, connection: null }).text).toBe('Queued for Claude Code; it gets this when its session is back.');
  });

  test('an agent that only reads the thread keeps the truthful wording and never offers Send now', () => {
    const line = deliveryLine({ ...base, wakes: false, connection: { busy: true, idle_since: null, send_now: true } });
    expect(line).toEqual({ state: 'saved', text: 'Saved for Claude Code. It sees it when it next reads this thread.' });
  });

  test('the asking session ended, or a message addressed to a session that stopped: the existing lines', () => {
    expect(deliveryLine({ ...base, askerEnded: { name: 'Claude Code' } })).toMatchObject({ state: 'saved', ended: true });
    expect(deliveryLine({ ...base, undelivered: { host: 'Pi' } }).state).toBe('undelivered');
  });

  test("the Sent row: queued for a waking agent, saved for one that reads the thread (and from an older Inbox)", () => {
    expect(sentRowLine('Pi', true)).toBe('Queued for Pi; it gets this as its next turn.');
    expect(sentRowLine('Codex', false)).toBe('Saved for Codex. It sees it when it next reads this thread.');
    expect(sentRowLine('Codex', undefined)).toBe('Saved for Codex. It sees it when it next reads this thread.');
  });
});

// The restart line (owner approval "restart-warning"): it explains a missing Send now, so it shows only
// when the session works, has no Send now, and runs an older plugin; never for an engine too old for
// Send now (a restart would not bring it, and the owner chose to say nothing about that).
describe('restartNote', () => {
  const outdated = { loaded: '0.28.21', installed: '0.28.23', fix: 'restart' as const };
  const busy = { busy: true, idle_since: null, send_now: false, outdated, engine: '2.1.305', restart_command: 'cd ~/code/billing-api && claude --resume abc' };
  test('busy, no Send now, an older plugin: the fix is /reload-plugins, with the resume command for the fallback', () => {
    const note = restartNote(busy)!;
    expect(note.fix).toBe('restart');
    expect(note.command).toBe('cd ~/code/billing-api && claude --resume abc');
    expect(note.updateCommand).toBeNull();
  });
  test('the same version reinstalled, and an older mod whose version is unknown, still lead with /reload-plugins', () => {
    expect(restartNote({ ...busy, outdated: { loaded: '0.28.23', installed: '0.28.23', fix: 'restart' } })!.fix).toBe('restart');
    expect(restartNote({ ...busy, outdated: { loaded: null, installed: '0.28.23', fix: 'restart' } })!.fix).toBe('restart');
  });
  test('the installed plugin is behind this Inbox: update the plugin first', () => {
    const note = restartNote({ ...busy, outdated: { loaded: '0.28.23', installed: '0.28.23', fix: 'update_plugin', update_command: 'claude plugin update x' } });
    expect(note!.fix).toBe('update_plugin');
    expect(note!.updateCommand).toBe('claude plugin update x');
  });
  test('a session that loaded a plugin with Send now (0.28.24 on) lacks it for another reason: the line never blames the plugin', () => {
    expect(INBOX_SEND_NOW_SINCE).toBe('0.28.24');
    expect(restartNote({ ...busy, outdated: { loaded: '0.28.24', installed: '0.28.25', fix: 'restart' } })).toBeNull();
    expect(restartNote({ ...busy, outdated: { loaded: '0.29.0', installed: '0.29.1', fix: 'restart' } })).toBeNull();
    // A development build counts as having it; an unknown version (an older mod) and anything older do not.
    expect(restartNote({ ...busy, outdated: { loaded: '0.0.0-dev', installed: '0.28.25', fix: 'restart' } })).toBeNull();
    expect(restartNote({ ...busy, outdated: { loaded: null, installed: '0.28.25', fix: 'restart' } })).not.toBeNull();
    expect(restartNote({ ...busy, outdated: { loaded: '0.28.23', installed: '0.28.25', fix: 'restart' } })).not.toBeNull();
  });
  test('nothing while idle, with Send now, up to date, for an engine too old, for Pi, or from an older Inbox', () => {
    expect(restartNote({ ...busy, busy: false })).toBeNull();
    expect(restartNote({ ...busy, send_now: true })).toBeNull();
    expect(restartNote({ ...busy, outdated: null })).toBeNull();
    expect(restartNote({ ...busy, engine: '2.1.290' })).toBeNull();
    expect(restartNote({ ...busy, outdated: { loaded: '0.28.20', installed: '0.28.25', fix: 'update_extension' } })).toBeNull();
    expect(restartNote({ busy: true, idle_since: null, send_now: false })).toBeNull();
    expect(restartNote(null)).toBeNull();
  });
});

describe('a reply another agent read', () => {
  test('names the reader, with the time, in place of Delivered', () => {
    expect(deliveryLine({ ...base, deliveredAt: '2026-10-16T17:12:00.000Z', wakes: false, readBy: 'Claude Code' })).toMatchObject({
      state: 'delivered',
      text: 'Read by Claude Code, 5:12 PM',
    });
  });

  test('no record: today\'s wording, for a thread from before it was recorded', () => {
    expect(deliveryLine({ ...base, deliveredAt: '2026-10-16T17:12:00.000Z', wakes: false }).text).toBe('Delivered to Claude Code, 5:12 PM');
    expect(deliveryLine({ ...base, deliveredAt: '2026-10-16T17:12:00.000Z', wakes: false, readBy: null }).text).toBe('Delivered to Claude Code, 5:12 PM');
  });

  test('not delivered yet: the name changes nothing', () => {
    expect(deliveryLine({ ...base, wakes: false, name: 'Cursor', readBy: 'Claude Code' }).text).toStartWith('Saved for Cursor.');
  });
});
