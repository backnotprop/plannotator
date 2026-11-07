/**
 * Moving between CallDiff pins must never strand a user's install: the older
 * pin's folder is never adopted, a too-old Node fails before any download,
 * stale folders go only after the new pin is published, and installed
 * language packs cross over instead of downloading again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CALLDIFF_COMMIT,
  CALLDIFF_VERSION,
  callFlowNodeVersionSupported,
  getCallFlowManagedRuntimeDir,
  installCallFlowRuntime,
  listStaleCallFlowRuntimeDirs,
  preflightCallFlowNode,
  preserveValidatedLanguagePacks,
  removeStaleCallFlowRuntimeDirs,
  resolveCallFlowRuntime,
} from "./call-flow";
import { CALL_FLOW_PACK_LOCKS } from "./call-flow-pack-locks";

const posixOnly = process.platform === "win32" ? test.skip : test;
const OLDER_PIN = { version: "0.4.1", commit: "a3194d20ca91ef6a314273d634e9b9c0db1c2707" };

let root = "";
let dataDir = "";
let store = "";
let previousDataDir: string | undefined;
let previousOverride: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-call-flow-upgrade-"));
  dataDir = join(root, "data");
  store = join(dataDir, "vendor", "call-flow");
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  previousOverride = process.env.PLANNOTATOR_CALLDIFF_PATH;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_CALLDIFF_PATH;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  if (previousOverride === undefined) delete process.env.PLANNOTATOR_CALLDIFF_PATH;
  else process.env.PLANNOTATOR_CALLDIFF_PATH = previousOverride;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Put a `node` that reports `version` and an `npm` that must not run first on
 * PATH. Downloads are blocked unless the test supplies a fake `fetch`.
 */
async function withFakeNode<T>(version: string, body: () => Promise<T>, fakeFetch?: typeof fetch): Promise<T> {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), `#!/bin/sh\necho ${version}\n`);
  writeFileSync(join(bin, "npm"), "#!/bin/sh\necho 'npm must not run' >&2\nexit 97\n");
  chmodSync(join(bin, "node"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  const previousPath = process.env.PATH;
  const previousFetch = globalThis.fetch;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  globalThis.fetch = fakeFetch ?? ((() => Promise.reject(new Error("Call flow must not download here."))) as unknown as typeof fetch);
  try {
    return await body();
  } finally {
    process.env.PATH = previousPath;
    globalThis.fetch = previousFetch;
  }
}

/** A managed core folder that looks fully installed for the given pin. */
function writeManagedCore(runtimeDir: string, pin: { version: string; commit: string }): void {
  const callDiffRoot = join(runtimeDir, "node_modules", "calldiff");
  mkdirSync(join(callDiffRoot, "dist"), { recursive: true });
  writeFileSync(join(callDiffRoot, "package.json"), JSON.stringify({ name: "calldiff", version: pin.version }));
  writeFileSync(join(callDiffRoot, "dist", "run.js"), "export const runDiff = () => { throw new Error('must not run'); };\n");
  writeFileSync(join(runtimeDir, ".calldiff-revision"), `${pin.commit}\n`);
  writeFileSync(join(runtimeDir, "package-lock.json"), readFileSync(join(import.meta.dir, "call-flow-runtime", "package-lock.json")));
  for (const [name, version] of [["tree-sitter", "0.25.1"], ["tree-sitter-javascript", "0.25.0"], ["tree-sitter-typescript", "0.23.2"]] as const) {
    mkdirSync(join(runtimeDir, "node_modules", name), { recursive: true });
    writeFileSync(join(runtimeDir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  }
}

function writeInstalledPack(
  runtimeDir: string,
  id: keyof typeof CALL_FLOW_PACK_LOCKS,
  packageName: string,
  version: string,
  marker: unknown,
): void {
  const packageRoot = join(runtimeDir, "grammar-cache", "node_modules", packageName);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version }));
  mkdirSync(join(runtimeDir, "grammar-cache", ".plannotator-locks"), { recursive: true });
  writeFileSync(join(runtimeDir, "grammar-cache", ".plannotator-locks", `${id}.json`), JSON.stringify(marker));
}

describe("the Node floor", () => {
  test("accepts exactly the Node versions CallDiff's engines field accepts (>=22.18.0)", () => {
    for (const version of ["v22.18.0", "v22.18.1", "v22.20.0", "v23.0.0", "v24.15.0", "v100.0.0"]) {
      expect(callFlowNodeVersionSupported(version)).toBe(true);
    }
    for (const version of ["v22.17.1", "v22.9.0", "v22.0.0", "v21.99.0", "v20.19.0", "v18.20.8", "", "node", "v22"]) {
      expect(callFlowNodeVersionSupported(version)).toBe(false);
    }
  });

  posixOnly("Node older than 22.18 says so plainly and fails the install before any download", async () => {
    const olderCore = join(store, `calldiff-${OLDER_PIN.version}`);
    writeManagedCore(olderCore, OLDER_PIN);
    await withFakeNode("v22.17.1", async () => {
      const message = "Call flow needs Node.js 22.18 or newer. You have Node.js v22.17.1.";
      expect(await preflightCallFlowNode()).toEqual({ ok: false, reason: "node-version", message });
      expect(await resolveCallFlowRuntime()).toEqual({ ok: false, reason: "node-version", message });
      expect(await installCallFlowRuntime()).toMatchObject({ ok: false, status: "failed", message });
    });
    // Nothing was half-installed, and the older pin's folder is kept for a downgrade.
    expect(readdirSync(store).filter((name) => name !== ".install.lock")).toEqual([`calldiff-${OLDER_PIN.version}`]);
    expect(readFileSync(join(olderCore, ".calldiff-revision"), "utf8").trim()).toBe(OLDER_PIN.commit);
  });
});

describe("moving between CallDiff pins", () => {
  posixOnly("an older pin's complete core is never resolved as the current one", async () => {
    writeManagedCore(join(store, `calldiff-${OLDER_PIN.version}`), OLDER_PIN);
    await withFakeNode("v24.15.0", async () => {
      expect(await resolveCallFlowRuntime()).toMatchObject({ ok: false, reason: "runtime-unavailable" });
      // The same build sitting under the current pin's name is stale, not adopted.
      writeManagedCore(getCallFlowManagedRuntimeDir(), OLDER_PIN);
      expect(await resolveCallFlowRuntime()).toMatchObject({ ok: false, reason: "version-mismatch" });
      writeManagedCore(getCallFlowManagedRuntimeDir(), { version: CALLDIFF_VERSION, commit: OLDER_PIN.commit });
      expect(await resolveCallFlowRuntime()).toMatchObject({ ok: false, reason: "revision-mismatch" });
    });
  });

  posixOnly("removes only older managed cores and interrupted-swap backups in its own store", () => {
    const keepNames = [
      `calldiff-${CALLDIFF_VERSION}`,
      "calldiff-99.0.0", // a newer Plannotator's pin survives a downgrade
      "calldiff-99.0.0.previous-5-6", // and so does its backup
      "calldiff-notes",
      ".calldiff-install-abc123",
      ".calldiff-stale-notes",
    ];
    for (const name of [...keepNames, `calldiff-${OLDER_PIN.version}`, `calldiff-${CALLDIFF_VERSION}.previous-12-34`]) {
      mkdirSync(join(store, name, "node_modules"), { recursive: true });
    }
    // A tombstone an earlier, interrupted cleanup left behind.
    mkdirSync(join(store, ".calldiff-stale-1-2-0", "node_modules"), { recursive: true });
    writeFileSync(join(store, ".install.lock"), "token");
    writeFileSync(join(store, "calldiff-0.3.0"), "a file, not a core");
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(store, "calldiff-0.2.0"));
    mkdirSync(join(dataDir, "vendor", "calldiff-0.1.0"), { recursive: true });

    expect(listStaleCallFlowRuntimeDirs(dataDir)).toEqual([
      join(store, `calldiff-${OLDER_PIN.version}`),
      join(store, `calldiff-${CALLDIFF_VERSION}.previous-12-34`),
    ].sort());
    removeStaleCallFlowRuntimeDirs(dataDir);

    expect(readdirSync(store).sort()).toEqual([...keepNames, ".install.lock", "calldiff-0.2.0", "calldiff-0.3.0"].sort());
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(dataDir, "vendor", "calldiff-0.1.0"))).toBe(true);
    expect(() => removeStaleCallFlowRuntimeDirs(join(root, "no-such-data-dir"))).not.toThrow();
  });

  test("an upgrade carries validated language packs over from the older pin's folder", async () => {
    const olderCore = join(store, `calldiff-${OLDER_PIN.version}`);
    writeInstalledPack(olderCore, "python", "tree-sitter-python", "0.25.0", CALL_FLOW_PACK_LOCKS.python);
    writeInstalledPack(olderCore, "ruby", "tree-sitter-ruby", "0.23.1", CALL_FLOW_PACK_LOCKS.ruby);
    writeInstalledPack(olderCore, "go", "tree-sitter-go", "0.25.0", { stale: true });
    const candidate = join(store, ".calldiff-install-test");
    mkdirSync(join(candidate, "node_modules", "calldiff", "dist"), { recursive: true });
    // The candidate core's extractor loads every grammar except Ruby's.
    writeFileSync(join(candidate, "node_modules", "calldiff", "dist", "extract.js"), [
      "export function extractFunctions(file) {",
      "  if (file.endsWith('.rb')) throw new Error('grammar did not load');",
      "  return [];",
      "}",
    ].join("\n"));

    const preserved = await preserveValidatedLanguagePacks(
      process.execPath,
      [getCallFlowManagedRuntimeDir(), olderCore],
      candidate,
    );

    expect(preserved).toEqual(["python"]);
    const cache = join(candidate, "grammar-cache");
    expect(JSON.parse(readFileSync(join(cache, "node_modules", "tree-sitter-python", "package.json"), "utf8")).version).toBe("0.25.0");
    expect(JSON.parse(readFileSync(join(cache, ".plannotator-locks", "python.json"), "utf8"))).toEqual(CALL_FLOW_PACK_LOCKS.python);
    // A stale marker is not verified, and a pack that fails to load does not cross.
    expect(existsSync(join(cache, "node_modules", "tree-sitter-go"))).toBe(false);
    expect(existsSync(join(cache, "node_modules", "tree-sitter-ruby"))).toBe(false);
    expect(existsSync(join(cache, ".plannotator-locks", "ruby.json"))).toBe(false);
  });

  posixOnly("a delete cut short never leaves a half-deleted older core under its own name", () => {
    const olderCore = join(store, `calldiff-${OLDER_PIN.version}`);
    writeManagedCore(olderCore, OLDER_PIN);
    // A read-only folder inside the core makes the recursive delete fail midway.
    chmodSync(join(olderCore, "node_modules", "tree-sitter"), 0o500);
    try {
      removeStaleCallFlowRuntimeDirs(dataDir);
      expect(existsSync(olderCore)).toBe(false);
      const tombstones = readdirSync(store).filter((name) => name.startsWith(".calldiff-stale-"));
      expect(tombstones).toHaveLength(1);
      // The next install sweeps the tombstone once it can be deleted.
      chmodSync(join(store, tombstones[0], "node_modules", "tree-sitter"), 0o755);
      removeStaleCallFlowRuntimeDirs(dataDir);
      expect(readdirSync(store)).toEqual([]);
    } finally {
      for (const name of existsSync(store) ? readdirSync(store) : []) {
        const path = join(store, name, "node_modules", "tree-sitter");
        if (existsSync(path)) chmodSync(path, 0o755);
      }
    }
  });

  posixOnly("a failure after the Node check (a wrong archive hash) keeps the older pin's folder", async () => {
    const olderCore = join(store, `calldiff-${OLDER_PIN.version}`);
    writeManagedCore(olderCore, OLDER_PIN);
    const wrongArchive = (async () => new Response("not the pinned CallDiff archive")) as unknown as typeof fetch;
    const result = await withFakeNode("v24.15.0", () => installCallFlowRuntime(), wrongArchive);
    expect(result).toMatchObject({ ok: false, status: "failed" });
    if (!result.ok) expect(result.message).toContain("SHA-512");
    expect(readdirSync(store).filter((name) => name !== ".install.lock")).toEqual([`calldiff-${OLDER_PIN.version}`]);
    expect(readFileSync(join(olderCore, ".calldiff-revision"), "utf8").trim()).toBe(OLDER_PIN.commit);
  });

  posixOnly("an already-installed current core still removes the older pin's folder", async () => {
    writeManagedCore(join(store, `calldiff-${OLDER_PIN.version}`), OLDER_PIN);
    writeManagedCore(getCallFlowManagedRuntimeDir(), { version: CALLDIFF_VERSION, commit: CALLDIFF_COMMIT });
    const result = await withFakeNode("v24.15.0", () => installCallFlowRuntime());
    expect(result).toMatchObject({ ok: true, status: "already-installed" });
    expect(readdirSync(store).filter((name) => name !== ".install.lock")).toEqual([`calldiff-${CALLDIFF_VERSION}`]);
  });
});
