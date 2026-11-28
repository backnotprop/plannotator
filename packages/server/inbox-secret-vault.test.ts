/**
 * Where a secret's value goes. Every store runs through a fake `VaultRun`: no test runs `security`, `secret-tool` or
 * PowerShell, or touches a real keychain. What regresses: a value on a command line (`ps` shows it), a value in an
 * error the person or a log sees, a file another account can read, the wrong store for a platform, and a Remove
 * the store refused reading as done.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dpapiVault, fileVault, InboxSecretReadError, keychainVault, memoryVault, scrubSecret, secretServiceVault, systemSecretVault, withFileFallback, type VaultRun } from "./inbox-secret-vault";

const SENTINEL = "TEST_ONLY_NOT_A_KEY_123";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-vault-"));
  dirs.push(dir);
  return dir;
};

/** Records each call; answers with `answer(argv)`. */
function fakeRun(answer: (argv: readonly string[], stdin: string | undefined) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const calls: { argv: readonly string[]; stdin: string | undefined }[] = [];
  const run: VaultRun = async (argv, options) => {
    calls.push({ argv, stdin: options.stdin });
    const out = answer(argv, options.stdin);
    return { code: out.code, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  };
  return { run, calls };
}

describe("the Keychain (macOS)", () => {
  test("the value goes on stdin as hex, never on a command line", async () => {
    const fake = fakeRun();
    await keychainVault(fake.run).set("prj_1:API_KEY", SENTINEL);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.argv).toEqual(["/usr/bin/security", "-i"]);
    expect(fake.calls[0]!.argv.join(" ")).not.toContain(SENTINEL);
    expect(fake.calls[0]!.stdin).toBe(`add-generic-password -U -s plannotator-inbox -a prj_1:API_KEY -l plannotator-inbox -X ${Buffer.from(SENTINEL).toString("hex")}\n`);
    expect(fake.calls[0]!.stdin).not.toContain(SENTINEL);
  });

  test("reads with -w; a missing item is null, a locked or denied one is an error that says so", async () => {
    const fake = fakeRun((argv) => (argv.includes("prj_1:A_KEY") ? { code: 0, stdout: `${SENTINEL}\n` } : argv.includes("prj_1:B_KEY") ? { code: 44 } : argv.includes("prj_1:C_KEY") ? { code: 36, stderr: "security: User interaction is not allowed." } : { code: 1, stderr: "security: SecKeychainSearchCopyNext: bad item." }));
    const vault = keychainVault(fake.run);
    expect(await vault.get("prj_1:A_KEY")).toBe(SENTINEL);
    expect(await vault.get("prj_1:B_KEY")).toBeNull();
    const locked = await vault.get("prj_1:C_KEY").catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(InboxSecretReadError);
    expect((locked as InboxSecretReadError).locked).toBe(true);
    const other = await vault.get("prj_1:D_KEY").catch((e: unknown) => e);
    expect((other as InboxSecretReadError).locked).toBe(false);
    expect((other as Error).message).toBe("The Keychain did not give it back: security: SecKeychainSearchCopyNext: bad item.");
  });

  test("a refusal is an error without the value in it", async () => {
    const fake = fakeRun((_argv, stdin) => ({ code: 0, stderr: `security: error writing ${stdin}` }));
    const error = await keychainVault(fake.run).set("prj_1:API_KEY", SENTINEL).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(SENTINEL);
    expect(String(error)).not.toContain(Buffer.from(SENTINEL).toString("hex"));
  });

  test("Remove: no such item is fine; any other refusal is an error", async () => {
    await keychainVault(fakeRun(() => ({ code: 44 })).run).remove("prj_1:API_KEY");
    expect(keychainVault(fakeRun(() => ({ code: 51, stderr: "User interaction is not allowed." })).run).remove("prj_1:API_KEY")).rejects.toThrow("The Keychain did not remove it: User interaction is not allowed.");
  });

  test("an account name that could break the command line is refused before anything runs", async () => {
    const fake = fakeRun();
    await expect(keychainVault(fake.run).set("prj_1:A\n-w x", SENTINEL)).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

describe("the Secret Service (Linux) and DPAPI (Windows)", () => {
  test("secret-tool takes the value on stdin", async () => {
    const fake = fakeRun();
    await secretServiceVault(fake.run).set("prj_1:API_KEY", SENTINEL);
    expect(fake.calls[0]!.argv).toEqual(["secret-tool", "store", "--label=Plannotator Inbox prj_1:API_KEY", "service", "plannotator-inbox", "account", "prj_1:API_KEY"]);
    expect(fake.calls[0]!.stdin).toBe(SENTINEL);
  });

  test("DPAPI: PowerShell gets the value on stdin; the file holds only the protected blob, 0600", async () => {
    const dir = temp();
    const fake = fakeRun((_argv, stdin) => ({ code: 0, stdout: stdin === SENTINEL ? "01000000d08c9ddf-protected" : SENTINEL }));
    const vault = dpapiVault(fake.run, dir);
    await vault.set("prj_1:API_KEY", SENTINEL);
    expect(fake.calls[0]!.argv.join(" ")).not.toContain(SENTINEL);
    const [file] = readdirSync(dir);
    expect(readFileSync(join(dir, file!), "utf8")).toBe("01000000d08c9ddf-protected");
    if (process.platform !== "win32") expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
    expect(await vault.get("prj_1:API_KEY")).toBe(SENTINEL);
  });
});

describe("the file only you can read", () => {
  test("folder 0700, file 0600, value read back; Remove deletes it", async () => {
    const dir = join(temp(), "secrets");
    const vault = fileVault(dir);
    await vault.set("prj_1:API_KEY", SENTINEL);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "prj_1__API_KEY")).mode & 0o777).toBe(0o600);
    }
    expect(await vault.get("prj_1:API_KEY")).toBe(SENTINEL);
    await vault.remove("prj_1:API_KEY");
    expect(await vault.get("prj_1:API_KEY")).toBeNull();
  });

  test("a keyring that refuses a save: the value goes to the file, and the card says so", async () => {
    const dir = temp();
    const refusing = { ...memoryVault("secret-service"), set: async () => Promise.reject(new Error("no keyring daemon")) };
    const vault = withFileFallback(refusing, fileVault(dir));
    await vault.set("prj_1:API_KEY", SENTINEL);
    expect(vault.kind).toBe("file");
    expect(await vault.get("prj_1:API_KEY")).toBe(SENTINEL);
  });
});

describe("which store", () => {
  const base = { dir: "/nowhere", run: fakeRun().run, which: () => "/usr/bin/secret-tool" };
  test("macOS the Keychain, Windows DPAPI, Linux the keyring only with a session bus, else the file", () => {
    expect(systemSecretVault({ ...base, platform: "darwin", env: {} }).kind).toBe("keychain");
    expect(systemSecretVault({ ...base, platform: "win32", env: {} }).kind).toBe("dpapi");
    expect(systemSecretVault({ ...base, platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" } }).kind).toBe("secret-service");
    expect(systemSecretVault({ ...base, platform: "linux", env: {} }).kind).toBe("file");
    expect(systemSecretVault({ ...base, platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "x" }, which: () => null }).kind).toBe("file");
    expect(systemSecretVault({ ...base, platform: "freebsd", env: {} }).kind).toBe("file");
  });

  test("scrubSecret takes every copy of the value out of a text", () => {
    expect(scrubSecret(`a ${SENTINEL} b ${SENTINEL}`, SENTINEL)).toBe("a •••• b ••••");
  });
});
