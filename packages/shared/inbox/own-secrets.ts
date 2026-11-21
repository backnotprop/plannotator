/**
 * The Inbox's own keys: the files under its data folder that let whoever holds them act as this Inbox or as one of
 * its devices. No agent attaches one, shows one as a picture or reads one into a walkthrough, here or paired: a paired
 * agent that read a device's secret could act as that device, which its pairing never allows (the identity the Inbox
 * gives each pairing). It is the Inbox guarding its own keys, the same for every agent, not a rule about the person's
 * files.
 *
 * The files, each written only by the code named (relative to the data folder):
 *  - `inbox/device-secrets/` (packages/shared/inbox/devices.ts: each paired phone's, machine's and agent's secret)
 *  - `inbox/cloud-agents.json` (packages/server/inbox-cloud-agents.ts: cloud agents and their wake keys)
 *  - `inbox/relay.json` (packages/server/inbox-relay.ts: the relay mailbox and its secret)
 *  - `inbox/machines.json` (packages/server/inbox-links.ts: this Inbox's tokens on linked machines' doors)
 *  - `inbox/inbox.json` (packages/shared/inbox/registry.ts: the running Inbox's port and token)
 *  - `inbox/tls/` (packages/server/inbox-lan.ts: the Wi-Fi door's key)
 *  - `inbox/secrets/` and `inbox/secrets.json` (packages/server/inbox-run-setup.ts: run setups' secrets)
 *  - `inbox/linear-key`, `inbox/voice-key` (inbox-linear-key.ts, inbox-voice.ts: saved API keys)
 *  - `inbox/antigravity/links/` (apps/hook/server/inbox-antigravity-command.ts: each running Antigravity CLI
 *    conversation's language server address and its CSRF token, which starts a turn in it)
 *  - `cloudflare-access/` (cf-tunnel.ts, cf-access-door.ts: the tunnel token and door sessions)
 *  - `secrets/` (packages/shared/spaces/credential.ts, sem-diff-opinion.ts)
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getPlannotatorDataDir } from "../data-dir";

export const INBOX_OWN_SECRET_PATHS: readonly string[] = [
  "inbox/device-secrets",
  "inbox/cloud-agents.json",
  "inbox/relay.json",
  "inbox/machines.json",
  "inbox/inbox.json",
  "inbox/tls",
  "inbox/secrets",
  "inbox/secrets.json",
  "inbox/linear-key",
  "inbox/voice-key",
  "inbox/antigravity/links",
  "cloudflare-access",
  "secrets",
];

const REFUSAL = "the Inbox's own keys are never attached or read (they would let anyone act as this Inbox or one of its devices).";

/** A path in each spelling it has: as given, and its realpath. */
function spellings(folder: string): string[] {
  const out = [resolve(folder)];
  try {
    const real = realpathSync(folder);
    if (real !== out[0]) out.push(real);
  } catch {
    // Not on disk: the spelling given is all there is.
  }
  return out;
}

/**
 * Why `path` (absolute: as named, or its realpath) may not be read, or null. `dataDirs`: the data folders to guard,
 * the one this process uses by default. Names are compared without case where the disk usually ignores it (macOS,
 * Windows), and an NTFS stream suffix (`relay.json::$DATA`) names its file.
 */
export function inboxOwnSecretRefusal(path: string, dataDirs: readonly string[] = [getPlannotatorDataDir()], platform: NodeJS.Platform = process.platform): string | null {
  if (!isAbsolute(path)) return null;
  const fold = platform === "darwin" || platform === "win32" ? (text: string) => text.toLowerCase() : (text: string) => text;
  const named = fold(resolve(path).replace(/:[^\\/]*$/, "").replace(/[. ]+$/, ""));
  // Each guarded entry where it really is too: a data folder's `inbox` (or an entry in it) may be a link elsewhere.
  const guarded = new Set(dataDirs.flatMap(spellings).flatMap((dir) => INBOX_OWN_SECRET_PATHS.flatMap((entry) => spellings(join(dir, ...entry.split("/"))))));
  for (const entry of guarded) {
    const rel = relative(fold(entry), named);
    // Inside: no step up (a child named `..foo` is inside), and not on another drive.
    if (rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..")) return REFUSAL;
  }
  return null;
}
