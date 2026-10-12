/**
 * Pair a phone's words and gate (pairing.ts), and Settings' addresses
 * (settingsRoute.ts). The gate is the owner's no-loop rule: a way switched
 * on shows the code, whatever the checks say.
 */
import { describe, expect, test } from 'bun:test';
import type { LanState, PairingChecks, TailnetState } from './api';
import { attemptNotes, canShowCode, hasFailure, pairedVia, tailscaleCheckLines, troubleshooting, wifiCheckLines } from './pairing';
import { parseSettingsHash, settingsHash } from './settingsRoute';

const lan = (over: Partial<LanState> = {}): LanState => ({ on: false, address: null, fingerprint: null, bonjour: false, error: null, ...over });
const tailnet = (over: Partial<TailnetState> = {}): TailnetState => ({ on: false, address: null, error: null, ...over });
const failingWifi: PairingChecks['wifi'] = { address: null, network: null, openssl: false, certificate: false, bonjour: false, firewall: 'block_all' };
const failingTailscale: PairingChecks['tailscale'] = { state: 'signed_out', login: null, https_certs: null, port_free: null, error: null };

describe('the gate on the code', () => {
  test('closed with no way switched on, whatever the checks', () => {
    expect(canShowCode(lan(), tailnet())).toBe(false);
    expect(canShowCode(null, null)).toBe(false);
  });

  test('open once a way is switched on, even with every check failing and the way not working yet', () => {
    expect(hasFailure(wifiCheckLines(failingWifi))).toBe(true);
    expect(hasFailure(tailscaleCheckLines(failingTailscale))).toBe(true);
    expect(canShowCode(lan({ on: true, error: 'The Inbox could not make its certificate.' }), tailnet())).toBe(true);
    expect(canShowCode(lan(), tailnet({ on: true, error: 'Tailscale is signed out.' }))).toBe(true);
  });
});

describe('the checks', () => {
  test('each failing check carries its fix in one line', () => {
    const more = (['cli_missing', 'no_answer', 'stopped', 'needs_approval', 'unknown'] as const).flatMap((state) => tailscaleCheckLines({ ...failingTailscale, state }));
    for (const line of [...wifiCheckLines(failingWifi), ...tailscaleCheckLines(failingTailscale), ...more]) {
      if (line.status === 'fail' || line.status === 'warn') expect(line.fix?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('an unknown firewall (not a Mac) adds no line; a certificate already made stands in for openssl', () => {
    const lines = wifiCheckLines({ address: '10.0.0.2', network: null, openssl: false, certificate: true, bonjour: true, firewall: 'unknown' });
    expect(lines.map((l) => l.status)).toEqual(['ok', 'ok', 'ok']);
    // A missing `tailscale` command and a slow one are not "Tailscale is not installed".
    expect(tailscaleCheckLines({ ...failingTailscale, state: 'cli_missing' }).map((l) => l.status)).toEqual(['fail']);
    expect(tailscaleCheckLines({ ...failingTailscale, state: 'no_answer' }).map((l) => l.status)).toEqual(['warn']);
  });
});

describe('what reached the door', () => {
  test('the newest attempt of each kind, newest first; the pairing is step 3, not a note', () => {
    const notes = attemptNotes([
      { via: 'tailnet', result: 'wrong_code', at: '1', tries_left: 4 },
      { via: 'wifi', result: 'code_over_wifi', at: '2' },
      { via: 'tailnet', result: 'wrong_code', at: '3', tries_left: 3 },
      { via: 'tailnet', result: 'redeemed', at: '4', device: 'iPhone' },
    ]);
    expect(notes.map((n) => [n.kind, n.via, n.triesLeft])).toEqual([
      ['wrong_code', 'tailnet', 3],
      ['code_over_wifi', 'wifi', undefined],
    ]);
    expect(pairedVia([{ via: 'wifi', result: 'redeemed', at: '4' }])).toBe('wifi');
  });

  test('the troubleshooting list follows the ways that were on', () => {
    expect(troubleshooting({ wifi: true, tailscale: false }, 'Home', null).map((i) => i.key)).toEqual(['wifi', 'local', 'vpn', 'app']);
    expect(troubleshooting({ wifi: false, tailscale: true }, null, 'me@example.com').map((i) => i.key)).toEqual(['tailscale', 'app']);
  });
});

describe("Settings' addresses", () => {
  test('#settings, a section, the pairing flow, an unknown section, and what is not Settings', () => {
    expect(parseSettingsHash('settings')).toEqual({ section: null, pair: false });
    expect(parseSettingsHash('settings/devices')).toEqual({ section: 'devices', pair: false });
    expect(parseSettingsHash('settings/devices/pair')).toEqual({ section: 'devices', pair: true });
    expect(parseSettingsHash('settings/general/pair')).toEqual({ section: 'general', pair: false });
    expect(parseSettingsHash('settings/nope')).toEqual({ section: null, pair: false });
    expect(parseSettingsHash('thread=msg_1')).toBeNull();
    expect(parseSettingsHash('settingsx')).toBeNull();
    expect(settingsHash({ section: 'devices', pair: true })).toBe('settings/devices/pair');
    expect(settingsHash({ section: 'about' })).toBe('settings/about');
    expect(settingsHash({ section: null })).toBe('settings');
  });
});
