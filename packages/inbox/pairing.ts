/**
 * Pair a phone, step by step (design of record
 * `.product/approved/inbox-settings-tabs/`, section 4): the words and the
 * gate, kept pure so they are tested without a window.
 *
 * The owner's no-loop rule (approval, decision 5): the computer-side checks
 * are advisory, never a gate. A failing check shows its fix and the person
 * can still continue. The ONLY gate on the code is a way being switched on
 * (`canShowCode`), because a code with no address in it is what sent the
 * owner's phone nowhere.
 */

import type { LanState, PairingAttempt, PairingChecks, TailnetState } from './api';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'later';

export interface CheckLine {
  status: CheckStatus;
  text: string;
  /** The fix, in one line, for a check that is not ok. */
  fix?: string;
}

/** Which ways are switched on, as the person set them (on even while not working: the card says why). */
export function waysOn(lan: LanState | null, tailnet: TailnetState | null): { wifi: boolean; tailscale: boolean } {
  return { wifi: lan?.on === true, tailscale: tailnet?.on === true };
}

/**
 * The one gate on step 2: at least one way is switched on. Never a check:
 * a check can be wrong (a firewall that macOS asks about, a Wi-Fi name it
 * hides), and a person who knows better must never be held in step 1.
 */
export function canShowCode(lan: LanState | null, tailnet: TailnetState | null): boolean {
  const on = waysOn(lan, tailnet);
  return on.wifi || on.tailscale;
}

/** What this computer can tell about the Wi-Fi way. */
export function wifiCheckLines(checks: PairingChecks['wifi']): CheckLine[] {
  const lines: CheckLine[] = [];
  if (checks.address) {
    lines.push({ status: 'ok', text: checks.network ? `On Wi-Fi “${checks.network}” at ${checks.address}` : `On this network at ${checks.address}` });
  } else {
    lines.push({ status: 'fail', text: 'This computer has no Wi-Fi or Ethernet address right now.', fix: 'Join a network, then Check again.' });
  }
  if (checks.certificate || checks.openssl) lines.push({ status: 'ok', text: 'Can make the certificate your phone checks' });
  else
    lines.push({
      status: 'fail',
      text: 'openssl is not installed, so the Inbox cannot make the certificate your phone checks.',
      fix: 'Install OpenSSL (on Debian or Ubuntu: sudo apt install openssl), then Check again.',
    });
  if (checks.bonjour) lines.push({ status: 'ok', text: 'Phones nearby can find it by name (Bonjour)' });
  else lines.push({ status: 'warn', text: 'Phones nearby will not list this computer by name.', fix: 'Scanning the code still pairs them.' });
  // Only the macOS application firewall can be read; elsewhere (`unknown`) nothing is claimed.
  if (checks.firewall === 'off') lines.push({ status: 'ok', text: 'The macOS firewall is off' });
  else if (checks.firewall === 'on')
    lines.push({ status: 'warn', text: 'The macOS firewall is on.', fix: 'If macOS asks whether Plannotator may accept incoming connections, choose Allow.' });
  else if (checks.firewall === 'block_all')
    lines.push({
      status: 'warn',
      text: 'The macOS firewall blocks incoming connections.',
      fix: 'Phones cannot connect until you allow Plannotator in System Settings → Network → Firewall.',
    });
  return lines;
}

/** What this computer can tell about the Tailscale way. */
export function tailscaleCheckLines(checks: PairingChecks['tailscale']): CheckLine[] {
  const installed: CheckLine = { status: 'ok', text: 'Tailscale is installed' };
  const later: CheckLine = { status: 'later', text: 'The rest is checked once it runs.' };
  switch (checks.state) {
    case 'cli_missing':
      // ENOENT: the command is missing, which the Mac App Store app is until its command-line tool is turned on.
      return [
        {
          status: 'fail',
          text: "The tailscale command isn't on PATH.",
          fix: 'With the Tailscale app, turn on its command-line tool (Tailscale → Settings → Install CLI); otherwise install Tailscale from https://tailscale.com/download and sign in with tailscale up. Then Check again.',
        },
      ];
    case 'no_answer':
      return [{ status: 'warn', text: "Tailscale didn't answer in time.", fix: 'Check again in a moment.' }];
    case 'stopped':
      return [installed, { status: 'fail', text: 'Tailscale is not running on this computer.', fix: 'Open Tailscale, then Check again.' }, later];
    case 'signed_out':
      return [installed, { status: 'fail', text: 'Tailscale is signed out on this computer.', fix: 'Open Tailscale and sign in, then Check again.' }, later];
    case 'needs_approval':
      return [installed, { status: 'fail', text: 'This computer is waiting for approval on your tailnet.', fix: 'Approve it in the Tailscale admin console, then Check again.' }, later];
    case 'starting':
      return [installed, { status: 'warn', text: 'Tailscale is starting.', fix: 'Check again in a moment.' }];
    case 'unknown':
      return [{ status: 'warn', text: 'This computer could not tell how Tailscale is doing.', fix: checks.error ? `Tailscale said: ${checks.error}` : 'Check again in a moment.' }];
    case 'running': {
      const lines: CheckLine[] = [{ status: 'ok', text: checks.login ? `Tailscale is running, signed in as ${checks.login}` : 'Tailscale is running' }];
      if (checks.https_certs === true) lines.push({ status: 'ok', text: 'HTTPS certificates are on for your tailnet' });
      else if (checks.https_certs === false)
        lines.push({
          status: 'fail',
          text: 'HTTPS certificates are off for your tailnet.',
          fix: 'Turn on HTTPS Certificates in the Tailscale admin console (DNS), then Check again.',
        });
      if (checks.port_free === true) lines.push({ status: 'ok', text: 'Port 8443 is free for the Inbox' });
      else if (checks.port_free === false)
        lines.push({ status: 'fail', text: 'Another tailscale serve mapping uses port 8443.', fix: 'Remove it with "tailscale serve --https=8443 off" if nothing needs it.' });
      return lines;
    }
  }
}

export function hasFailure(lines: readonly CheckLine[]): boolean {
  return lines.some((line) => line.status === 'fail');
}

/** What the phone needs for the Wi-Fi way: what this computer cannot check. */
export function wifiPhoneNeeds(network: string | null): string[] {
  return [
    `Joined to the same Wi-Fi${network ? `, “${network}”` : ' as this computer'}. A guest network often keeps devices apart.`,
    'Allow “Local Network” when Plannotator asks (later: iPhone Settings → Privacy & Security → Local Network).',
  ];
}

/** What the phone needs for the Tailscale way. */
export function tailscalePhoneNeeds(login: string | null): string[] {
  return [`The Tailscale app, signed in to the same tailnet${login ? ` (${login})` : ''} and switched on.`];
}

/** The line beside Continue: what happens next, or what is missing. */
export function continueHint(on: { wifi: boolean; tailscale: boolean }, network: string | null): string {
  if (!on.wifi && !on.tailscale) return 'Turn on a way to continue.';
  const wifi = network ? `on “${network}”` : 'on this Wi-Fi';
  if (on.wifi && on.tailscale) return `Your phone will reach this computer ${wifi}, or over Tailscale from anywhere.`;
  if (on.wifi) return `Your phone will reach this computer ${wifi}.`;
  return 'Your phone will reach this computer over Tailscale, at home or away.';
}

const VIA: Record<PairingAttempt['via'], string> = { wifi: 'over Wi-Fi', tailnet: 'over Tailscale', local: "on this computer's own address" };

/**
 * What the computer saw while the code showed, newest first, as notes: a
 * phone that came and failed says what to do. A pairing is not a note
 * (step 3 says it).
 */
export interface AttemptNote {
  key: string;
  kind: PairingAttempt['result'];
  via: PairingAttempt['via'];
  /** `wrong_code`: tries left on the code. */
  triesLeft?: number;
  title: string;
  text: string;
}

export function attemptNotes(attempts: readonly PairingAttempt[]): AttemptNote[] {
  const notes: AttemptNote[] = [];
  const seen = new Set<string>();
  for (const attempt of [...attempts].reverse()) {
    if (attempt.result === 'redeemed' || seen.has(attempt.result)) continue;
    seen.add(attempt.result);
    const key = `${attempt.result}-${attempt.at}`;
    if (attempt.result === 'wrong_code') {
      const left = attempt.tries_left ?? 0;
      notes.push({
        key,
        kind: attempt.result, via: attempt.via,
        triesLeft: left,
        title: `A phone reached this computer ${VIA[attempt.via]}, but the six digits did not match.`,
        text: left > 0 ? `${left} ${left === 1 ? 'try' : 'tries'} left. Check the digits, or scan the code instead.` : 'The code closed after five wrong tries. Make a new code.',
      });
    } else if (attempt.result === 'code_over_wifi') {
      notes.push({ key, kind: attempt.result, via: attempt.via, title: 'A phone reached this computer over Wi-Fi and typed the code.', text: 'Over Wi-Fi, pairing works only by scanning. Scan the code instead.' });
    } else if (attempt.result === 'old_code') {
      notes.push({ key, kind: attempt.result, via: attempt.via, title: `A phone reached this computer ${VIA[attempt.via]} with an older code.`, text: 'Scan the code on screen now.' });
    } else if (attempt.result === 'expired') {
      notes.push({ key, kind: attempt.result, via: attempt.via, title: `A phone reached this computer ${VIA[attempt.via]} after the code closed.`, text: 'Make a new code and scan it.' });
    }
  }
  return notes;
}

/** How the phone reached the computer, for step 3, from the pairing's own attempt. */
export function pairedVia(attempts: readonly PairingAttempt[]): PairingAttempt['via'] | null {
  return [...attempts].reverse().find((a) => a.result === 'redeemed')?.via ?? null;
}

/** The numbered list when the code expired and no phone reached this computer, for the ways that were on. */
export function troubleshooting(
  on: { wifi: boolean; tailscale: boolean },
  network: string | null,
  login: string | null,
): { key: string; title: string; text: string }[] {
  const items: { key: string; title: string; text: string }[] = [];
  if (on.wifi) {
    items.push({
      key: 'wifi',
      title: 'Same Wi-Fi?',
      text: `Check that the phone is on ${network ? `“${network}”` : 'the same Wi-Fi as this computer'}, not mobile data or a guest network. Guest and office networks often keep devices apart.`,
    });
    items.push({ key: 'local', title: 'Local Network allowed?', text: 'On the iPhone: Settings → Privacy & Security → Local Network → Plannotator on.' });
    items.push({ key: 'vpn', title: 'A VPN on the phone?', text: 'Some VPNs hide the local network. Pause it, or use Tailscale instead.' });
  }
  if (on.tailscale) {
    items.push({
      key: 'tailscale',
      title: 'Tailscale on, on the phone?',
      text: `Open Tailscale on the phone and check it is connected${login ? ` and signed in as ${login}` : ' and signed in to the same tailnet'}.`,
    });
  }
  items.push({ key: 'app', title: 'Scanned in Plannotator?', text: 'Scan with the Plannotator app, not the Camera app.' });
  return items;
}
