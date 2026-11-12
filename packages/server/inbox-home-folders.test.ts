import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNewHomeFolder, isHomeItself, listHomeFolders, makeHomeFolder, resolveHomeFolder, shownParent, type FolderPlaces } from "./inbox-home-folders";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-home-folders-")));
const home = join(root, "home");
const outside = join(root, "elsewhere");
for (const dir of ["code/billing-api", "code/billing-svc", "code/infra", "code/.cache", ".ssh", "srv"]) mkdirSync(join(home, dir), { recursive: true });
mkdirSync(join(outside, "secrets"), { recursive: true });
writeFileSync(join(home, "code", "notes.txt"), "not a folder");
symlinkSync(join(home, "srv"), join(home, "code", "srv-link"));
symlinkSync(outside, join(home, "code", "out-link"));
symlinkSync(outside, join(home, "away"));
symlinkSync(join(home, ".ssh"), join(home, "code", "sshlink"));
symlinkSync(join(home, "code", ".cache"), join(home, "cachelink"));
mkdirSync(join(home, "x"), { recursive: true });
symlinkSync(home, join(home, "code", "homelink"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("folders under home, by name only", () => {
  test("a folder's folders, alphabetical: no files, no hidden ones, no links that leave home", () => {
    expect(listHomeFolders(home, "~/code")).toEqual({ path: "~/code", exists: true, state: "folder", folders: ["billing-api", "billing-svc", "infra", "srv-link"], writable: true });
    expect(listHomeFolders(home, "~/")).toEqual({ path: "~", exists: true, state: "folder", folders: ["code", "srv", "x"], writable: true });
  });

  test("a path that isn't there, or is a file, says so, with the nearest folder above it that is and its folders", () => {
    const code = { path: "~/code", folders: ["billing-api", "billing-svc", "infra", "srv-link"] };
    expect(listHomeFolders(home, "~/code/biling-svc")).toEqual({ path: "~/code/biling-svc", exists: false, state: "missing", folders: [], nearest: code });
    expect(listHomeFolders(home, "~/code/notes.txt")).toEqual({ path: "~/code/notes.txt", exists: false, state: "file", folders: [], nearest: code });
    expect(listHomeFolders(home, "~/code/nope/deeper/still")).toEqual({ path: "~/code/nope/deeper/still", exists: false, state: "missing", folders: [], nearest: code });
    expect(listHomeFolders(home, "~/work")).toEqual({ path: "~/work", exists: false, state: "missing", folders: [], nearest: { path: "~", folders: ["code", "srv", "x"] } });
  });

  test("never a path that steps out, or isn't a full one: .., a bare name", () => {
    for (const typed of ["~/..", "~/code/../../elsewhere", "code", "/Volumes/../etc"]) {
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "outside" }]);
    }
  });

  test("never a system folder, typed or through a link (the temp folder is one, on macOS and Linux)", () => {
    for (const typed of ["/etc", "/usr/local", outside, "~/away", "~/away/secrets", "~/code/out-link"]) {
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "system" }]);
    }
  });

  test("never a hidden folder, at any depth", () => {
    for (const typed of ["~/.ssh", "~/code/.cache", "~/.ssh/x"]) expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "hidden" }]);
  });

  test("a backslash or a NUL is never a way in: refused before the path is read", () => {
    for (const typed of ["~/\\.ssh", "~/x\\..\\.ssh", "~/x\\..\\.claude", "~/code\\infra", "~/x\0/.ssh", "~/\0"]) {
      expect([typed, resolveHomeFolder(home, typed)]).toEqual([typed, { ok: false, refused: "outside" }]);
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "outside" }]);
    }
  });

  test("a link in home that lands in a hidden folder is hidden: not listed, not resolved", () => {
    expect(listHomeFolders(home, "~/code")).not.toMatchObject({ folders: expect.arrayContaining(["sshlink"]) });
    expect(listHomeFolders(home, "~/")).not.toMatchObject({ folders: expect.arrayContaining(["cachelink"]) });
    for (const typed of ["~/code/sshlink", "~/cachelink", join(home, "code", "sshlink")]) {
      expect([typed, resolveHomeFolder(home, typed)]).toEqual([typed, { ok: false, refused: "hidden" }]);
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "hidden" }]);
    }
  });

  test("a path that isn't there answers as its nearest folder that is: never a way to learn what a hidden folder, or one outside home, holds", () => {
    for (const typed of ["~/code/sshlink/nope", "~/code/sshlink/nope/deeper", "~/cachelink/nope"]) {
      expect([typed, resolveHomeFolder(home, typed)]).toEqual([typed, { ok: false, refused: "hidden" }]);
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "hidden" }]);
    }
    for (const typed of ["~/code/out-link/nope", "~/away/nope/deeper", "/usr/nope"]) {
      expect([typed, resolveHomeFolder(home, typed)]).toEqual([typed, { ok: false, refused: "system" }]);
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "system" }]);
    }
    expect(resolveHomeFolder(home, "~/code/srv-link/nope")).toEqual({ ok: true, exists: false, state: "missing", real: null, shown: "~/code/srv-link/nope", start: false });
  });

  test("a link back to home is not listed: home is never a folder to start in", () => {
    expect(listHomeFolders(home, "~/code")).toMatchObject({ exists: true, folders: ["billing-api", "billing-svc", "infra", "srv-link"] });
  });

  test("home itself is listed, and is home (never a folder to start in)", () => {
    const at = resolveHomeFolder(home, "~");
    expect(at).toMatchObject({ ok: true, exists: true, shown: "~", start: false });
    expect(isHomeItself(home, (at as { real: string }).real)).toBe(true);
    expect(isHomeItself(home, (resolveHomeFolder(home, "~/code") as { real: string }).real)).toBe(false);
  });

  test("a full path inside home reads as ~/…; doubled and trailing slashes are fine", () => {
    expect(resolveHomeFolder(home, join(home, "code", "infra"))).toEqual({ ok: true, exists: true, state: "folder", real: join(home, "code", "infra"), shown: "~/code/infra", start: true });
    expect(resolveHomeFolder(home, "~//code/infra/")).toMatchObject({ ok: true, exists: true, shown: "~/code/infra" });
  });
});

describe("what a typed path is: folder, locked, file, missing", () => {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const states = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-home-states-")));
  const h = join(states, "home");
  for (const dir of ["code/web-app/src", "code/locked/secret", "Documents/Archive/2024", "code/side-project"]) mkdirSync(join(h, dir), { recursive: true });
  writeFileSync(join(h, "code", "roadmap"), "a file with no extension");
  writeFileSync(join(h, "code", "web-app", "README.md"), "a file");
  chmodSync(join(h, "code", "locked"), 0o000);
  chmodSync(join(h, "Documents", "Archive"), 0o555);
  afterAll(() => {
    chmodSync(join(h, "code", "locked"), 0o755);
    chmodSync(join(h, "Documents", "Archive"), 0o755);
    rmSync(states, { recursive: true, force: true });
  });

  test.skipIf(asRoot)("a folder lists which of its folders can't be opened, and whether a folder can be made in it", () => {
    expect(listHomeFolders(h, "~/code")).toEqual({ path: "~/code", exists: true, state: "folder", folders: ["locked", "side-project", "web-app"], locked: ["locked"], writable: true });
    expect(listHomeFolders(h, "~/Documents/Archive")).toMatchObject({ exists: true, state: "folder", folders: ["2024"], writable: false });
  });

  test.skipIf(asRoot)("a folder that can't be opened is locked, never listed and never a folder to start in", () => {
    expect(listHomeFolders(h, "~/code/locked")).toMatchObject({ path: "~/code/locked", exists: false, state: "locked", folders: [], nearest: { path: "~/code" } });
    expect(resolveHomeFolder(h, "~/code/locked")).toMatchObject({ ok: true, exists: false, state: "locked", real: null });
    expect(listHomeFolders(h, "~/code/locked/secret")).toMatchObject({ state: "missing", blocked: { path: "~/code/locked", state: "locked" } });
  });

  test("a file is a file; a path under a file is stopped by that file", () => {
    expect(listHomeFolders(h, "~/code/roadmap")).toMatchObject({ path: "~/code/roadmap", exists: false, state: "file" });
    expect(listHomeFolders(h, "~/code/web-app/README.md")).toMatchObject({ state: "file", nearest: { path: "~/code/web-app", folders: ["src"] } });
    expect(listHomeFolders(h, "~/code/roadmap/x/y")).toMatchObject({ state: "missing", blocked: { path: "~/code/roadmap", state: "file" } });
    expect(listHomeFolders(h, "~/cdoe/pricing-page")).not.toHaveProperty("blocked");
  });

  test("Create: only the last folder, in a folder that is there and can be written", () => {
    expect(checkNewHomeFolder(h, "~/code/pricing-page")).toEqual({ ok: true, real: null, parent: join(h, "code"), name: "pricing-page", shown: "~/code/pricing-page" });
    expect(checkNewHomeFolder(h, "~/newproj")).toMatchObject({ ok: true, parent: h, name: "newproj" });
    expect(checkNewHomeFolder(h, "~/code/web-app")).toMatchObject({ ok: true, real: join(h, "code", "web-app") });
    expect(checkNewHomeFolder(h, "~/code/new-client/site")).toEqual({ ok: false, code: "folder_missing", message: "There's no ~/code/new-client. Only the last folder in a path can be made. Nothing was sent." });
    expect(checkNewHomeFolder(h, "~/code/roadmap")).toEqual({ ok: false, code: "folder_unavailable", message: "There's already a file named roadmap. Pick another name. Nothing was sent." });
    expect(checkNewHomeFolder(h, "~/code/a:b")).toMatchObject({ ok: false, code: "validation_error" });
    expect(checkNewHomeFolder(h, "~/code/.hidden")).toMatchObject({ ok: false, code: "validation_error", message: "Hidden folders can't be picked. Nothing was sent." });
    expect(checkNewHomeFolder(h, "/etc/x")).toMatchObject({ ok: false, code: "validation_error" });
  });

  test.skipIf(asRoot)("Create: never in a folder that can't be written or opened", () => {
    expect(checkNewHomeFolder(h, "~/Documents/Archive/q3")).toEqual({ ok: false, code: "folder_unavailable", message: "Can't make a folder in ~/Documents/Archive: no permission. Nothing was sent." });
    expect(checkNewHomeFolder(h, "~/code/locked")).toMatchObject({ ok: false, code: "folder_unavailable", message: "Can't open ~/code/locked: no permission. Nothing was sent." });
    expect(existsSync(join(h, "Documents", "Archive", "q3"))).toBe(false);
  });

  test("makeHomeFolder makes one level and says whether it made it", () => {
    const made = makeHomeFolder(join(h, "code"), "fresh");
    expect(made).toMatchObject({ real: join(h, "code", "fresh"), made: true });
    expect(makeHomeFolder(join(h, "code"), "fresh")).toMatchObject({ made: false, inode: made.inode });
    expect(() => makeHomeFolder(join(h, "code", "nope"), "x")).toThrow();
    expect(existsSync(join(h, "code", "nope"))).toBe(false);
  });

  test("makeHomeFolder never starts in a link swapped in after the checks: it leads out of home or into a hidden folder", () => {
    mkdirSync(join(h, ".ssh"), { recursive: true });
    symlinkSync(join(h, ".ssh"), join(h, "code", "swapped"));
    expect(() => makeHomeFolder(join(h, "code"), "swapped")).toThrow();
    symlinkSync(states, join(h, "code", "swapped-out"));
    expect(() => makeHomeFolder(join(h, "code"), "swapped-out")).toThrow();
  });
});

describe("folders on other drives", () => {
  const disk = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-drives-")));
  const volumes = join(disk, "Volumes");
  const users = join(disk, "Users");
  const me = join(users, "me");
  const places: FolderPlaces = { system: [join(disk, "System")], open: [], containers: ["/", volumes, users] };
  for (const dir of ["Studio SSD/footage/day-1", "Studio SSD/renders", "Studio SSD/.Trashes", "Backup", ".hidden-drive/x"]) mkdirSync(join(volumes, dir), { recursive: true });
  for (const dir of ["code/web", "System/Library"]) mkdirSync(join(dir === "code/web" ? me : disk, dir), { recursive: true });
  writeFileSync(join(volumes, "Studio SSD", "notes.txt"), "a file");
  symlinkSync(disk, join(volumes, "Macintosh HD"));
  symlinkSync(join(disk, "System"), join(volumes, "Studio SSD", "syslink"));
  afterAll(() => rmSync(disk, { recursive: true, force: true }));
  const ssd = join(volumes, "Studio SSD");

  test("the drives folder lists each drive, never a hidden one or the boot disk's link, and is never started in", () => {
    expect(listHomeFolders(me, `${volumes}/`, places)).toEqual({ path: volumes, exists: true, state: "folder", folders: ["Backup", "Studio SSD"], start: false, writable: true });
  });

  test("a drive's root is started in, shown by its full path; its folders list as in home", () => {
    expect(resolveHomeFolder(me, ssd, places)).toEqual({ ok: true, exists: true, state: "folder", real: ssd, shown: ssd, start: true });
    expect(listHomeFolders(me, `${ssd}/`, places)).toEqual({ path: ssd, exists: true, state: "folder", folders: ["footage", "renders"], writable: true });
    expect(resolveHomeFolder(me, `${ssd}/footage/day-1`, places)).toMatchObject({ ok: true, exists: true, start: true, shown: `${ssd}/footage/day-1` });
  });

  test("hidden and system folders stay out on a drive too, however they are reached", () => {
    for (const typed of [`${ssd}/.Trashes`, `${volumes}/.hidden-drive/x`]) expect([typed, resolveHomeFolder(me, typed, places)]).toEqual([typed, { ok: false, refused: "hidden" }]);
    for (const typed of [join(disk, "System"), `${ssd}/syslink`, `${ssd}/syslink/nope`]) expect([typed, resolveHomeFolder(me, typed, places)]).toEqual([typed, { ok: false, refused: "system" }]);
  });

  test("a folder above home, home itself, and the top of the disk are listed but never started in", () => {
    expect(listHomeFolders(me, users, places)).toMatchObject({ exists: true, folders: ["me"], nostart: ["me"], start: false });
    expect(resolveHomeFolder(me, disk, places)).toMatchObject({ ok: true, exists: true, start: false });
    expect(resolveHomeFolder(me, `${disk}/Volumes/Macintosh HD`, places)).toMatchObject({ ok: true, start: false });
    expect(listHomeFolders(me, disk, places)).toMatchObject({ folders: ["Users", "Volumes"], nostart: ["Users", "Volumes"], start: false });
  });

  test("a path that isn't there on a drive offers the nearest folder that is; a missing drive offers the drives", () => {
    expect(listHomeFolders(me, `${ssd}/footge/x`, places)).toMatchObject({ exists: false, state: "missing", nearest: { path: ssd, folders: ["footage", "renders"] } });
    expect(listHomeFolders(me, `${volumes}/Archive/old-site`, places)).toMatchObject({ exists: false, state: "missing", nearest: { path: volumes, folders: ["Backup", "Studio SSD"] } });
  });

  test("Create on a drive: the last folder, in a folder that is there", () => {
    expect(checkNewHomeFolder(me, `${ssd}/grade`, places)).toEqual({ ok: true, real: null, parent: ssd, name: "grade", shown: `${ssd}/grade` });
    expect(checkNewHomeFolder(me, `${ssd}/notes.txt`, places)).toMatchObject({ ok: false, code: "folder_unavailable" });
    expect(checkNewHomeFolder(me, `${ssd}/.cache`, places)).toMatchObject({ ok: false, message: "Hidden folders can't be picked. Nothing was sent." });
    expect(checkNewHomeFolder(me, `${disk}/System/x`, places)).toMatchObject({ ok: false, message: "System folders can't be picked. Nothing was sent." });
  });

  test("a shown path's parent: in home and out", () => {
    expect([shownParent("~/code/x"), shownParent("~/x"), shownParent("/Volumes/A/b"), shownParent("/Volumes")]).toEqual(["~/code", "~", "/Volumes/A", "/"]);
  });
});
