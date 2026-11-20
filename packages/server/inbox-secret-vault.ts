/**
 * Plannotator Inbox: where a saved secret's value lives (`:::secret`). One
 * small interface, four stores, no native modules:
 *
 * - macOS: the login Keychain, through `security`. The value goes in on stdin
 *   (`security -i`, as hex with `-X`), never on a command line `ps` shows.
 * - Linux: the Secret Service (GNOME Keyring, KWallet), through
 *   `secret-tool`, which reads the value from stdin.
 * - Windows: DPAPI for the signed-in account, through PowerShell, which reads
 *   the value from stdin and writes the protected blob to a file only that
 *   account's DPAPI can open.
 * - Elsewhere, or when the store above cannot be reached: a file only this
 *   account can read (folder 0700, file 0600), said so in those words.
 *
 * Every program runs through `VaultRun`, so tests pass a fake and never run
 * `security`, `secret-tool` or PowerShell. Error text never carries the value.
 */

import { childEnv } from "@plannotator/shared/child-env";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Which store holds the values, and its words for the card. */
export type InboxSecretStoreKind = "keychain" | "secret-service" | "dpapi" | "file";

/**
 * Where a saved value is kept, as the card says it after Save ("Saved 10:12 AM · in your Keychain"). `own`: the
 * computer's own window ("your Keychain"); a phone or a linked machine names the computer, so its store is "its".
 */
export function inboxSecretStorePlace(kind: InboxSecretStoreKind, own: boolean): string {
  const whose = own ? "your" : "its";
  return {
    keychain: `in ${whose} Keychain`,
    "secret-service": `in ${whose} system keyring`,
    dpapi: "protected by Windows for your account",
    file: "in a file only you can read",
  }[kind];
}

/**
 * What Save does, in words, under every secret field: "Saved to your Mac's Keychain.", "Saved to Studio Mac's
 * Keychain." (a phone or a linked machine names the computer). The card adds that the agent never sees it.
 */
export function inboxSecretKeptWords(kind: InboxSecretStoreKind, computer: string): string {
  const whose = computer.endsWith("s") ? `${computer}'` : `${computer}'s`;
  return {
    keychain: `Saved to ${whose} Keychain.`,
    "secret-service": `Saved to ${whose} system keyring.`,
    dpapi: `Saved on ${computer}, protected by Windows.`,
    file: "Saved to a file only you can read.",
  }[kind];
}

/** Where a value is read from, in words, for "Couldn't read NAME from your Keychain." */
export const INBOX_SECRET_STORE_FROM: Record<InboxSecretStoreKind, string> = {
  keychain: "from your Keychain",
  "secret-service": "from your system keyring",
  dpapi: "with Windows data protection",
  file: "from its file",
};

/** Where a missing value would have been, in words: "NAME is no longer in your Keychain." */
export const INBOX_SECRET_STORE_IN: Record<InboxSecretStoreKind, string> = {
  keychain: "in your Keychain",
  "secret-service": "in your system keyring",
  dpapi: "in its protected file",
  file: "in its file",
};

/**
 * A read the store refused or could not answer. `locked`: it said it is locked or that it asked the person (a
 * Keychain waiting to be unlocked, a denied prompt), so "Unlock it if it asks" is true.
 */
export class InboxSecretReadError extends Error {
  constructor(
    message: string,
    readonly locked: boolean,
  ) {
    super(message);
  }
}
const LOCKED_RE = /lock|interaction|denied|cancel|not allowed|authoriz|prompt|dismiss/i;
const readFailure = (where: string, stderr: string, code: number): InboxSecretReadError => {
  const said = stderr.trim().split("\n")[0]?.slice(0, 200).replace(/\.+$/, "") ?? "";
  return new InboxSecretReadError(`${where} did not give it back${said ? `: ${said}` : ` (exit ${code})`}.`, LOCKED_RE.test(said));
};

export interface InboxSecretVault {
  kind: InboxSecretStoreKind;
  /** The value; null when there is none (removed in the store itself); throws when the store would not answer. */
  get: (account: string) => Promise<string | null>;
  set: (account: string, value: string) => Promise<void>;
  remove: (account: string) => Promise<void>;
}

/** Runs a program with `stdin` written then closed; never through a shell. */
export type VaultRun = (argv: readonly string[], options: { stdin?: string; env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;

const SERVICE = "plannotator-inbox";

/** Text that may hold the value, with the value taken out (an error from a store, said to the person). */
export function scrubSecret(text: string, value: string): string {
  return value.length > 0 ? text.split(value).join("••••") : text;
}

const fail = (where: string, value: string, stderr: string): never => {
  const said = scrubSecret(stderr, value).trim().split("\n")[0]?.slice(0, 200) ?? "";
  throw new Error(`${where} did not save it${said ? `: ${said}` : ""}.`);
};

const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,160}$/;
const checkAccount = (account: string) => {
  if (!ACCOUNT_RE.test(account)) throw new Error("Not a secret's account name.");
};

/** macOS: the login Keychain through `security`. */
export function keychainVault(run: VaultRun): InboxSecretVault {
  return {
    kind: "keychain",
    get: async (account) => {
      checkAccount(account);
      const out = await run(["/usr/bin/security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"], {});
      if (out.code === 0) return out.stdout.replace(/\n$/, "");
      // 44: no such item (deleted in Keychain Access). Anything else: locked, denied, or no answer.
      if (out.code === 44) return null;
      throw readFailure("The Keychain", out.stderr, out.code);
    },
    set: async (account, value) => {
      checkAccount(account);
      const hex = Buffer.from(value, "utf8").toString("hex");
      const out = await run(["/usr/bin/security", "-i"], { stdin: `add-generic-password -U -s ${SERVICE} -a ${account} -l ${SERVICE} -X ${hex}\n` });
      // `security -i` may say its command line back: the hex form of the value comes out too.
      if (out.code !== 0 || /error|usage/i.test(out.stderr)) fail("The Keychain", value, scrubSecret(out.stderr, hex));
    },
    remove: async (account) => {
      checkAccount(account);
      const out = await run(["/usr/bin/security", "delete-generic-password", "-s", SERVICE, "-a", account], {});
      // 44: there was no such item, which is what Remove wants.
      if (out.code !== 0 && out.code !== 44) throw new Error(`The Keychain did not remove it${out.stderr.trim() ? `: ${out.stderr.trim()}` : "."}`);
    },
  };
}

/** Linux: the Secret Service through `secret-tool`. */
export function secretServiceVault(run: VaultRun, tool = "secret-tool"): InboxSecretVault {
  return {
    kind: "secret-service",
    get: async (account) => {
      checkAccount(account);
      const out = await run([tool, "lookup", "service", SERVICE, "account", account], {});
      if (out.code === 0 && out.stdout !== "") return out.stdout.replace(/\n$/, "");
      // Nothing said: no such item. Words on stderr: the keyring refused (locked, no daemon).
      if (out.stderr.trim() === "") return null;
      throw readFailure("The system keyring", out.stderr, out.code);
    },
    set: async (account, value) => {
      checkAccount(account);
      const out = await run([tool, "store", `--label=Plannotator Inbox ${account}`, "service", SERVICE, "account", account], { stdin: value });
      if (out.code !== 0) fail("The system keyring", value, out.stderr);
    },
    remove: async (account) => {
      checkAccount(account);
      const out = await run([tool, "clear", "service", SERVICE, "account", account], {});
      if (out.code !== 0 && out.stderr.trim() !== "") throw new Error(`The system keyring did not remove it: ${out.stderr.trim()}`);
    },
  };
}

/** A file name for an account: its characters are already safe, `:` aside. */
const fileOf = (dir: string, account: string, ext = "") => join(dir, `${account.replaceAll(":", "__")}${ext}`);

const writePrivate = (dir: string, path: string, text: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
};

/** Windows: DPAPI for the signed-in account, through PowerShell; the protected blob in `dir`. */
export function dpapiVault(run: VaultRun, dir: string, powershell = "powershell.exe"): InboxSecretVault {
  const ps = (script: string) => [powershell, "-NoProfile", "-NonInteractive", "-Command", script];
  const PROTECT = "$v=[Console]::In.ReadToEnd();$s=ConvertTo-SecureString -String $v -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))";
  const UNPROTECT = "$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd());$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))";
  return {
    kind: "dpapi",
    get: async (account) => {
      checkAccount(account);
      let blob: string;
      try {
        blob = readFileSync(fileOf(dir, account, ".dpapi"), "utf8");
      } catch {
        return null;
      }
      const out = await run(ps(UNPROTECT), { stdin: blob });
      if (out.code === 0) return out.stdout;
      throw readFailure("Windows data protection", out.stderr, out.code);
    },
    set: async (account, value) => {
      checkAccount(account);
      const out = await run(ps(PROTECT), { stdin: value });
      if (out.code !== 0 || out.stdout.trim() === "") fail("Windows data protection", value, out.stderr);
      writePrivate(dir, fileOf(dir, account, ".dpapi"), out.stdout.trim());
    },
    remove: async (account) => {
      checkAccount(account);
      rmSync(fileOf(dir, account, ".dpapi"), { force: true });
    },
  };
}

/** Anywhere: a file only this account can read (folder 0700, file 0600). */
export function fileVault(dir: string): InboxSecretVault {
  return {
    kind: "file",
    get: async (account) => {
      checkAccount(account);
      try {
        return readFileSync(fileOf(dir, account), "utf8");
      } catch {
        return null;
      }
    },
    set: async (account, value) => {
      checkAccount(account);
      writePrivate(dir, fileOf(dir, account), value);
    },
    remove: async (account) => {
      checkAccount(account);
      rmSync(fileOf(dir, account), { force: true });
    },
  };
}

/** For tests: values in memory only. `failNext` makes the next set throw (a locked keychain). */
export function memoryVault(kind: InboxSecretStoreKind = "keychain"): InboxSecretVault & { values: Map<string, string>; failNext: boolean; failRemove: boolean; locked: Set<string> } {
  const values = new Map<string, string>();
  const vault = {
    kind,
    values,
    failNext: false,
    /** Remove throws (a Keychain that refuses). */
    failRemove: false,
    /** Accounts whose read fails (a locked Keychain, a denied read). */
    locked: new Set<string>(),
    get: async (account: string) => {
      if (vault.locked.has(account)) throw new InboxSecretReadError("The Keychain is locked.", true);
      return values.get(account) ?? null;
    },
    set: async (account: string, value: string) => {
      if (vault.failNext) {
        vault.failNext = false;
        throw new Error("The Keychain is locked.");
      }
      values.set(account, value);
    },
    remove: async (account: string) => {
      if (vault.failRemove) throw new Error("The Keychain did not remove it.");
      values.delete(account);
    },
  };
  return vault;
}

/**
 * The store this computer has. Linux uses the Secret Service only while a session bus is there to reach it; a
 * computer with neither store (a server, a container) keeps the file.
 */
export function systemSecretVault(options: { platform: NodeJS.Platform; dir: string; run: VaultRun; env: Readonly<Record<string, string | undefined>>; which: (cmd: string) => string | null }): InboxSecretVault {
  if (options.platform === "darwin") return keychainVault(options.run);
  if (options.platform === "win32") return dpapiVault(options.run, options.dir);
  const tool = options.env.DBUS_SESSION_BUS_ADDRESS ? options.which("secret-tool") : null;
  if (options.platform === "linux" && tool) return withFileFallback(secretServiceVault(options.run, tool), fileVault(options.dir));
  return fileVault(options.dir);
}

/**
 * A store that can fail to answer (the keyring daemon not running): a save it refuses goes to the file instead, and
 * reads look in both. `kind` is the one the last save used, so the card says where the value went.
 */
export function withFileFallback(primary: InboxSecretVault, file: InboxSecretVault): InboxSecretVault {
  const vault: InboxSecretVault = {
    kind: primary.kind,
    // The file first (a value the keyring refused to keep), then the keyring; its refusal counts only when the file
    // has nothing either.
    get: async (account) => {
      const kept = await file.get(account);
      return kept !== null ? kept : primary.get(account);
    },
    set: async (account, value) => {
      try {
        await primary.set(account, value);
        await file.remove(account);
        vault.kind = primary.kind;
      } catch {
        await file.set(account, value);
        vault.kind = "file";
      }
    },
    remove: async (account) => {
      let failure: unknown = null;
      await primary.remove(account).catch((error: unknown) => {
        failure = error;
      });
      await file.remove(account);
      // Say so only when the value is still there to read: a keyring that is not running holds nothing reachable.
      if (failure && (await primary.get(account).catch(() => null)) !== null) throw failure;
    },
  };
  return vault;
}

/** The real `VaultRun`: Bun.spawn, stdin written then closed, no shell, 15 s at most. */
export const spawnVaultRun: VaultRun = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ?? childEnv(),
    windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};
