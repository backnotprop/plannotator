import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareBuildStamps, installEmbeddedApp, rememberForApp, SNAPSHOTS_APP_NAME, SNAPSHOTS_BUNDLE_ID, snapshotsAppDefaultsArgv, snapshotsAppUrl } from "./snapshots-app";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plist(build: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleVersion</key><string>${build}</string></dict></plist>
`;
}

/** A stand-in app bundle with this build stamp, zipped the way build.sh zips the real one. */
function zippedApp(root: string, build: string): string {
  const dir = mkdtempSync(join(root, "build-"));
  const contents = join(dir, `${SNAPSHOTS_APP_NAME}.app`, "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), plist(build));
  writeFileSync(join(contents, "marker"), build);
  const zip = join(root, `app-${build}.zip`);
  const result = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(dir, `${SNAPSHOTS_APP_NAME}.app`), zip]);
  if (result.status !== 0) throw new Error("ditto failed");
  return zip;
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-snapshots-app-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const installed = () => readFileSync(join(home, "Applications", `${SNAPSHOTS_APP_NAME}.app`, "Contents", "marker"), "utf8");
  return { root, home, installed };
}

describe("compareBuildStamps", () => {
  test("orders release and local stamps numerically, segment by segment", () => {
    expect(compareBuildStamps("0.29.0.812", "0.29.0.812")).toBe(0);
    expect(compareBuildStamps("0.29.0.900", "0.29.0.812")).toBe(1);
    expect(compareBuildStamps("0.28.9.999", "0.29.0.1")).toBe(-1);
    expect(compareBuildStamps("0.29.10.1", "0.29.9.1")).toBe(1);
    expect(compareBuildStamps("0.29.0", "0.29.0.0")).toBe(0);
    // A local timestamp build sorts above any release, so it is never replaced by one.
    expect(compareBuildStamps("0.29.0.812", "20261008124501")).toBe(-1);
  });
});

describe("the app's URL and defaults", () => {
  test("a URL carries an action and a kind, never a path or a program", () => {
    expect(snapshotsAppUrl("capture", "app")).toBe("plannotator-snapshots://capture?kind=app");
    expect(snapshotsAppUrl("show", "region")).toBe("plannotator-snapshots://show");
    const argv = snapshotsAppDefaultsArgv("/data dir", ["/bin/plannotator"]);
    expect(argv).toEqual([
      ["write", SNAPSHOTS_BUNDLE_ID, "dataDir", "-string", "/data dir"],
      ["write", SNAPSHOTS_BUNDLE_ID, "cli", "-array", "-string", "/bin/plannotator"],
    ]);
  });
});

describe("rememberForApp", () => {
  const recorder = () => {
    const calls: string[][] = [];
    return { calls, run: (argv: string[]) => (calls.push(argv), { status: 0, stderr: "" }) };
  };

  test("a run from source never writes the app's defaults", () => {
    const r = recorder();
    // No __CLI_VERSION__, and the executable is bun: exactly what `bun apps/hook/server/index.ts snapshot` is.
    expect(rememberForApp("/tmp/test-data", [process.execPath, "/src/index.ts"], { version: undefined, execPath: process.execPath, run: r.run })).toBe(false);
    // Even a version, when the executable is not the installed binary (the real check against ~/.local/bin).
    expect(rememberForApp("/tmp/test-data", [process.execPath], { version: "0.29.0", execPath: process.execPath, run: r.run })).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("the installed release binary writes both keys", () => {
    const r = recorder();
    const written = rememberForApp("/data", ["/home/me/.local/bin/plannotator"], { version: "0.29.0", execPath: "/home/me/.local/bin/plannotator", isManaged: () => true, run: r.run });
    expect(written).toBe(true);
    expect(r.calls).toEqual(snapshotsAppDefaultsArgv("/data", ["/home/me/.local/bin/plannotator"]));
  });
});

describe.skipIf(process.platform !== "darwin")("installEmbeddedApp", () => {
  test("installs, then keeps the same build without unpacking again", () => {
    const s = sandbox();
    const zip = zippedApp(s.root, "0.29.0.10");
    expect(installEmbeddedApp({ zip, build: "0.29.0.10", home: s.home })?.outcome).toBe("installed");
    expect(s.installed()).toBe("0.29.0.10");
    expect(installEmbeddedApp({ zip: join(s.root, "missing.zip"), build: "0.29.0.10", home: s.home })?.outcome).toBe("current");
  });

  test("updates an older build", () => {
    const s = sandbox();
    installEmbeddedApp({ zip: zippedApp(s.root, "0.29.0.10"), build: "0.29.0.10", home: s.home });
    expect(installEmbeddedApp({ zip: zippedApp(s.root, "0.29.1.11"), build: "0.29.1.11", home: s.home })?.outcome).toBe("updated");
    expect(s.installed()).toBe("0.29.1.11");
    expect(readdirSync(join(s.home, "Applications"))).toEqual([`${SNAPSHOTS_APP_NAME}.app`]);
  });

  test("never downgrades a newer build, unless forced", () => {
    const s = sandbox();
    installEmbeddedApp({ zip: zippedApp(s.root, "0.30.0.50"), build: "0.30.0.50", home: s.home });
    const older = zippedApp(s.root, "0.29.0.10");
    expect(installEmbeddedApp({ zip: older, build: "0.29.0.10", home: s.home })?.outcome).toBe("newer-installed");
    expect(s.installed()).toBe("0.30.0.50");
    expect(installEmbeddedApp({ zip: older, build: "0.29.0.10", home: s.home, force: true })?.outcome).toBe("updated");
    expect(s.installed()).toBe("0.29.0.10");
  });

  test("nothing embedded: nothing installed", () => {
    const s = sandbox();
    expect(installEmbeddedApp({ home: s.home, zip: undefined })).toBeNull();
    expect(existsSync(join(s.home, "Applications"))).toBe(false);
  });
});
