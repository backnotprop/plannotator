/**
 * Plannotator Inbox: the secrets the person saved for a project (`:::secret`).
 *
 * The values live in the vault (inbox-secret-vault.ts). This file keeps only
 * what the window shows: each project's names, when each was saved, and
 * where. No part of a value (not even its last characters) is in it. It is
 * `inbox/secrets.json` (0600); no value is ever written to it, to the store,
 * to a log line or to what an agent gets.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { INBOX_SECRET_NAME_RE, inboxSecretNameRefused } from "@plannotator/core/inbox-run-blocks";
import type { InboxSecretStoreKind, InboxSecretVault } from "./inbox-secret-vault";

export interface InboxSavedSecret {
  name: string;
  saved_at: string;
  store: InboxSecretStoreKind;
}

/** The most a value may be: a key, a token, a password; not a file. */
export const INBOX_SECRET_MAX_CHARS = 8_192;
/** Values shorter than this are hidden only where they stand alone (a whole word), not inside other words. */
export const INBOX_SECRET_REDACT_FROM = 4;
/** How long a run waits for the vault (a locked Keychain asks the person first). */
export const INBOX_SECRET_READ_MS = 10_000;

type Index = Record<string, Record<string, InboxSavedSecret>>;

export interface InboxSecrets {
  list: (projectId: string) => InboxSavedSecret[];
  /** Saves (or replaces) a value. Returns whether it replaced one. */
  save: (projectId: string, name: string, value: string) => Promise<{ saved: InboxSavedSecret; replaced: boolean }>;
  /** Removes a value; throws when the vault could not, and then the name stays listed. */
  remove: (projectId: string, name: string) => Promise<boolean>;
  /**
   * The values of the saved names among `names`, read at once, for a run's environment and its output's
   * redaction. `unreadable`: saved names the vault did not give back (locked, denied, gone, too slow).
   */
  read: (projectId: string, names: readonly string[]) => Promise<{ values: Record<string, string>; unreadable: string[] }>;
  /** Removes the secrets of projects that are gone (a deleted project's values leave the vault too). */
  prune: (projectAlive: (projectId: string) => boolean) => Promise<void>;
}

/** A value the person pasted, checked. Never says the value back. */
export function checkSecretValue(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "value: text." };
  // A paste often brings a newline at the end; nothing else is trimmed (a password may end in a space).
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") return { ok: false, message: "Paste or type the value first." };
  if (/[\r\n]/.test(value)) return { ok: false, message: "A secret is one line: this one has a line break in it." };
  // Output loses control characters before secrets are hidden in it, so a value holding one could show.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return { ok: false, message: "A secret can't hold a control character (like an escape). Paste only the value." };
  if (value.length > INBOX_SECRET_MAX_CHARS) return { ok: false, message: "That is too long for a secret." };
  return { ok: true, value };
}

/** A name a secret may have: the shape, and not one programs read to start (inboxSecretNameRefused). */
export function checkSecretName(raw: unknown): string | null {
  return typeof raw === "string" && INBOX_SECRET_NAME_RE.test(raw) && !inboxSecretNameRefused(raw) ? raw : null;
}

export const secretAccount = (projectId: string, name: string): string => `${projectId}:${name}`;

export function createInboxSecrets(options: { file: string; vault: InboxSecretVault; now?: () => Date; readMs?: number }): InboxSecrets {
  const now = options.now ?? (() => new Date());
  const read = (): Index => {
    try {
      const parsed = JSON.parse(readFileSync(options.file, "utf8")) as { projects?: Index };
      return parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {};
    } catch {
      return {};
    }
  };
  const write = (projects: Index) => {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    const temp = `${options.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, options.file);
  };
  // One save or remove at a time, so two windows cannot interleave the index.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };

  return {
    list: (projectId) => Object.values(read()[projectId] ?? {}).sort((a, b) => a.name.localeCompare(b.name)),
    save: (projectId, name, value) =>
      serial(async () => {
        await options.vault.set(secretAccount(projectId, name), value);
        const projects = read();
        const replaced = !!projects[projectId]?.[name];
        const saved: InboxSavedSecret = { name, saved_at: now().toISOString(), store: options.vault.kind };
        projects[projectId] = { ...(projects[projectId] ?? {}), [name]: saved };
        write(projects);
        return { saved, replaced };
      }),
    remove: (projectId, name) =>
      serial(async () => {
        await options.vault.remove(secretAccount(projectId, name));
        const projects = read();
        if (!projects[projectId]?.[name]) return false;
        delete projects[projectId]![name];
        if (Object.keys(projects[projectId]!).length === 0) delete projects[projectId];
        write(projects);
        return true;
      }),
    read: async (projectId, names) => {
      const saved = read()[projectId] ?? {};
      const wanted = names.filter((name) => saved[name]);
      const values: Record<string, string> = {};
      const unreadable: string[] = [];
      await Promise.all(
        wanted.map(async (name) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const slow = new Promise<null>((done) => {
            timer = setTimeout(() => done(null), options.readMs ?? INBOX_SECRET_READ_MS);
          });
          const value = await Promise.race([options.vault.get(secretAccount(projectId, name)).catch(() => null), slow]);
          clearTimeout(timer);
          if (value === null) unreadable.push(name);
          else values[name] = value;
        }),
      );
      return { values, unreadable: names.filter((name) => unreadable.includes(name)) };
    },
    prune: (projectAlive) =>
      serial(async () => {
        const projects = read();
        const gone = Object.keys(projects).filter((projectId) => !projectAlive(projectId));
        if (gone.length === 0) return;
        for (const projectId of gone) {
          for (const name of Object.keys(projects[projectId]!)) await options.vault.remove(secretAccount(projectId, name)).catch(() => {});
          delete projects[projectId];
        }
        write(projects);
      }),
  };
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Output with every secret value replaced by `••••`, longest first. A value of 4 or more characters goes wherever
 * it is; a shorter one only where it stands as a whole word, so it does not eat ordinary words.
 */
export function redactSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length)) {
    out = value.length >= INBOX_SECRET_REDACT_FROM ? out.split(value).join("••••") : out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(value)}(?![\\p{L}\\p{N}_])`, "gu"), "••••");
  }
  return out;
}

/** The line still being written, with a secret's first characters hidden when they end it (the rest may follow). */
export function hideSecretPrefixTail(text: string, values: readonly string[]): string {
  for (const value of values) {
    if (value.length < INBOX_SECRET_REDACT_FROM) continue;
    for (let n = Math.min(value.length - 1, text.length); n >= 3; n--) {
      if (text.endsWith(value.slice(0, n))) return `${text.slice(0, text.length - n)}••••`;
    }
  }
  return text;
}

/** Names in a login environment that usually hold a credential (OPENAI_API_KEY, GH_TOKEN, DB_PASSWORD). */
const CREDENTIAL_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/** The login env's credential-like values, hidden in a run's output too (it goes to the agent). Not paths. */
export function loginEnvCredentials(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !CREDENTIAL_NAME_RE.test(name) || /^[/~.]|^[A-Za-z]:[\\/]/.test(value) || /\s/.test(value)) continue;
    out.push(value);
  }
  return out;
}
