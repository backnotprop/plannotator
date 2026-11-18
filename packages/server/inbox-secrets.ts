/**
 * Plannotator Inbox: the secrets the person saved for a project (`:::secret`).
 *
 * The values live in the vault (inbox-secret-vault.ts). This file keeps only
 * what the window shows: each project's names, when each was saved, where,
 * and the last 4 characters of a long value (none of a short one). It is
 * `inbox/secrets.json` (0600); no value is ever written to it, to the store,
 * to a log line or to what an agent gets.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { INBOX_SECRET_NAME_RE } from "@plannotator/core/inbox-run-blocks";
import type { InboxSecretStoreKind, InboxSecretVault } from "./inbox-secret-vault";

export interface InboxSavedSecret {
  name: string;
  saved_at: string;
  /** The value's last 4 characters, only when it has 16 or more; null otherwise. */
  last4: string | null;
  store: InboxSecretStoreKind;
}

/** The most a value may be: a key, a token, a password; not a file. */
export const INBOX_SECRET_MAX_CHARS = 8_192;
/** A value this long shows its last 4 characters; a shorter one shows none. */
export const INBOX_SECRET_LAST4_FROM = 16;
/** Values shorter than this are not hidden in output: they would hide ordinary words. */
export const INBOX_SECRET_REDACT_FROM = 4;

type Index = Record<string, Record<string, InboxSavedSecret>>;

export interface InboxSecrets {
  list: (projectId: string) => InboxSavedSecret[];
  /** Saves (or replaces) a value. Returns whether it replaced one. */
  save: (projectId: string, name: string, value: string) => Promise<{ saved: InboxSavedSecret; replaced: boolean }>;
  remove: (projectId: string, name: string) => Promise<boolean>;
  /** Every saved value of a project, for a run's environment and its output's redaction. */
  values: (projectId: string) => Promise<Record<string, string>>;
}

/** A value the person pasted, checked. Never says the value back. */
export function checkSecretValue(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "value: text." };
  // A paste often brings a newline at the end; nothing else is trimmed (a password may end in a space).
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") return { ok: false, message: "Paste or type the value first." };
  if (/[\r\n\0]/.test(value)) return { ok: false, message: "A secret is one line: this one has a line break in it." };
  if (value.length > INBOX_SECRET_MAX_CHARS) return { ok: false, message: "That is too long for a secret." };
  return { ok: true, value };
}

export function checkSecretName(raw: unknown): string | null {
  return typeof raw === "string" && INBOX_SECRET_NAME_RE.test(raw) ? raw : null;
}

export const secretAccount = (projectId: string, name: string): string => `${projectId}:${name}`;

export function createInboxSecrets(options: { file: string; vault: InboxSecretVault; now?: () => Date }): InboxSecrets {
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
        const saved: InboxSavedSecret = {
          name,
          saved_at: now().toISOString(),
          last4: value.length >= INBOX_SECRET_LAST4_FROM ? value.slice(-4) : null,
          store: options.vault.kind,
        };
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
    values: async (projectId) => {
      const out: Record<string, string> = {};
      for (const name of Object.keys(read()[projectId] ?? {})) {
        const value = await options.vault.get(secretAccount(projectId, name)).catch(() => null);
        if (value !== null) out[name] = value;
      }
      return out;
    },
  };
}

/** Output with every saved value (of 4 or more characters) replaced by `••••`, longest first. */
export function redactSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of [...values].filter((v) => v.length >= INBOX_SECRET_REDACT_FROM).sort((a, b) => b.length - a.length)) out = out.split(value).join("••••");
  return out;
}
