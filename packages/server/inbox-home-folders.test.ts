import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHomeItself, listHomeFolders, resolveHomeFolder } from "./inbox-home-folders";

// A made-up home with a code folder, a hidden folder, a file, and links in and out of home.
const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-home-folders-")));
const home = join(root, "home");
const outside = join(root, "elsewhere");
for (const dir of ["code/billing-api", "code/billing-svc", "code/infra", "code/.cache", ".ssh", "srv"]) mkdirSync(join(home, dir), { recursive: true });
mkdirSync(join(outside, "secrets"), { recursive: true });
writeFileSync(join(home, "code", "notes.txt"), "not a folder");
symlinkSync(join(home, "srv"), join(home, "code", "srv-link"));
symlinkSync(outside, join(home, "code", "out-link"));
symlinkSync(outside, join(home, "away"));
// Links that stay in home but land in a hidden folder.
symlinkSync(join(home, ".ssh"), join(home, "code", "sshlink"));
symlinkSync(join(home, "code", ".cache"), join(home, "cachelink"));
mkdirSync(join(home, "x"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("folders under home, by name only", () => {
  test("a folder's folders, alphabetical: no files, no hidden ones, no links that leave home", () => {
    expect(listHomeFolders(home, "~/code")).toEqual({ path: "~/code", exists: true, folders: ["billing-api", "billing-svc", "infra", "srv-link"] });
    expect(listHomeFolders(home, "~/")).toEqual({ path: "~", exists: true, folders: ["code", "srv", "x"] });
  });

  test("a path that isn't there, or is a file, says so, with the nearest folder above it that is and its folders", () => {
    const code = { path: "~/code", folders: ["billing-api", "billing-svc", "infra", "srv-link"] };
    expect(listHomeFolders(home, "~/code/biling-svc")).toEqual({ path: "~/code/biling-svc", exists: false, folders: [], nearest: code });
    expect(listHomeFolders(home, "~/code/notes.txt")).toEqual({ path: "~/code/notes.txt", exists: false, folders: [], nearest: code });
    expect(listHomeFolders(home, "~/code/nope/deeper/still")).toEqual({ path: "~/code/nope/deeper/still", exists: false, folders: [], nearest: code });
    expect(listHomeFolders(home, "~/work")).toEqual({ path: "~/work", exists: false, folders: [], nearest: { path: "~", folders: ["code", "srv", "x"] } });
  });

  test("never outside home: .., an absolute path elsewhere, a link out of home", () => {
    for (const typed of ["~/..", "~/code/../../elsewhere", "/etc", outside, "~/away", "~/away/secrets", "~/code/out-link", "code"]) {
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "outside" }]);
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

  test("home itself is listed, and is home (never a folder to start in)", () => {
    const at = resolveHomeFolder(home, "~");
    expect(at).toMatchObject({ ok: true, exists: true, shown: "~" });
    expect(isHomeItself(home, (at as { real: string }).real)).toBe(true);
    expect(isHomeItself(home, (resolveHomeFolder(home, "~/code") as { real: string }).real)).toBe(false);
  });

  test("a full path inside home reads as ~/…; doubled and trailing slashes are fine", () => {
    expect(resolveHomeFolder(home, join(home, "code", "infra"))).toEqual({ ok: true, exists: true, real: join(home, "code", "infra"), shown: "~/code/infra" });
    expect(resolveHomeFolder(home, "~//code/infra/")).toMatchObject({ ok: true, exists: true, shown: "~/code/infra" });
  });
});
