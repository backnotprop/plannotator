import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHomeFolders, resolveHomeFolder } from "./inbox-home-folders";

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
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("folders under home, by name only", () => {
  test("a folder's folders, alphabetical: no files, no hidden ones, no links that leave home", () => {
    expect(listHomeFolders(home, "~/code")).toEqual({ path: "~/code", exists: true, folders: ["billing-api", "billing-svc", "infra", "srv-link"] });
    expect(listHomeFolders(home, "~/")).toEqual({ path: "~", exists: true, folders: ["code", "srv"] });
  });

  test("a path that isn't there, or is a file, says so", () => {
    expect(listHomeFolders(home, "~/code/biling-svc")).toEqual({ path: "~/code/biling-svc", exists: false, folders: [] });
    expect(listHomeFolders(home, "~/code/notes.txt")).toEqual({ path: "~/code/notes.txt", exists: false, folders: [] });
  });

  test("never outside home: .., an absolute path elsewhere, a link out of home", () => {
    for (const typed of ["~/..", "~/code/../../elsewhere", "/etc", outside, "~/away", "~/away/secrets", "~/code/out-link", "code"]) {
      expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "outside" }]);
    }
  });

  test("never a hidden folder, at any depth", () => {
    for (const typed of ["~/.ssh", "~/code/.cache", "~/.ssh/x"]) expect([typed, listHomeFolders(home, typed)]).toEqual([typed, { refused: "hidden" }]);
  });

  test("a full path inside home reads as ~/…; doubled and trailing slashes are fine", () => {
    expect(resolveHomeFolder(home, join(home, "code", "infra"))).toEqual({ ok: true, exists: true, real: join(home, "code", "infra"), shown: "~/code/infra" });
    expect(resolveHomeFolder(home, "~//code/infra/")).toMatchObject({ ok: true, exists: true, shown: "~/code/infra" });
  });
});
