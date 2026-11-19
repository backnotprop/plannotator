/**
 * `plannotator theme …` through the real CLI entry (index.ts), as an agent runs
 * it: nothing else running, a scratch data dir and HOME. The failures these
 * guard: a good file not kept, or kept under another id; a refusal that exits
 * 0, takes more than one line, or does not name its field; anything written
 * when a file is refused; the contrast note turning into a refusal; `use`
 * writing a half the theme cannot draw; `remove` losing the file or leaving
 * config.json pointing at a theme that is gone.
 *
 * Starts no Inbox and no server. Temp folders are left in the OS temp dir.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const fixtures = resolve(import.meta.dir, "..", "..", "..", "packages", "core", "fixtures", "themes");

function world() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-theme-cli-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  mkdirSync(home);
  mkdirSync(dataDir);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, "run", entry, "theme", ...args], {
      cwd: root,
      stdin: "ignore",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        HOME: home,
        USERPROFILE: home,
        PLANNOTATOR_DATA_DIR: dataDir,
        PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
        PLANNOTATOR_BROWSER: NO_BROWSER,
        PLANNOTATOR_INBOX_CONNECT: "0",
        PLANNOTATOR_UPDATE_CHECK: "0",
        PLANNOTATOR_TEST_SANDBOX: "1",
        NO_ANON_PING: "1",
      },
    });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const file = (name: string, body: unknown) => {
    const path = join(root, name);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return name;
  };
  const config = () => (existsSync(join(dataDir, "config.json")) ? JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) : {});
  const themes = () => (existsSync(join(dataDir, "themes")) ? readdirSync(join(dataDir, "themes")).filter((f) => f.endsWith(".json")).sort() : []);
  return { root, dataDir, run, file, config, themes };
}

const lines = (text: string) => text.split("\n").filter(Boolean);

describe("plannotator theme", () => {
  test("add: a good file of each format is kept under its id, one line each", () => {
    const w = world();
    const ours = w.run("add", join(fixtures, "instrument.plannotator-theme.json"));
    expect(ours.code).toBe(0);
    expect(lines(ours.stdout)).toHaveLength(1);
    expect(ours.stdout).toContain('"Instrument" (instrument)');
    expect(ours.stdout).toContain("dark and light");
    const base16 = w.run("add", join(fixtures, "tomorrow-night.base16.yaml"));
    expect(base16.code).toBe(0);
    expect(base16.stdout).toContain("converted from a base16 scheme: dark only");
    const vscode = w.run("add", join(fixtures, "monokai-classic.vscode-theme.json"), "--name", "Monokai Night", "--id", "monokai-night");
    expect(vscode.code).toBe(0);
    expect(vscode.stdout).toContain('"Monokai Night" (monokai-night), converted from a VS Code theme');
    expect(w.themes()).toEqual(["instrument.json", "monokai-night.json", "tomorrow-night.json"]);
    expect(ours.stderr + base16.stderr + vscode.stderr).toBe("");
  }, 60_000);

  test("add refuses a bad file in one stderr line naming the field, exits 1, and writes nothing", () => {
    const w = world();
    const cases: [string, unknown, string][] = [
      ["bad-colour.json", { plannotatorTheme: 1, id: "harbor", name: "Harbor", dark: { background: "#000; } body { display: none" } }, "dark.background"],
      ["built-in.json", { plannotatorTheme: 1, id: "dracula", name: "Mine", dark: { background: "#000" } }, ": id: "],
      ["not-a-theme.json", { hello: "world" }, "(file)"],
      ["typo.json", { plannotatorTheme: 1, id: "harbor", name: "Harbor", dark: { backgroud: "#000" } }, "dark.backgroud"],
    ];
    for (const [name, body, field] of cases) {
      const out = w.run("add", w.file(name, body));
      expect({ name, code: out.code, stdout: out.stdout }).toEqual({ name, code: 1, stdout: "" });
      expect(lines(out.stderr)).toHaveLength(1);
      expect(out.stderr).toStartWith(`invalid_theme: ${name}: `);
      expect(out.stderr).toContain(field);
    }
    const missing = w.run("add", "nope.json");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toStartWith("unreadable: nope.json: no such file");
    const badFlag = w.run("add", join(fixtures, "tomorrow-night.base16.yaml"), "--id", "Not An Id");
    expect(badFlag.code).toBe(1);
    expect(badFlag.stderr).toStartWith("invalid_theme: --id: ");
    expect(w.themes()).toEqual([]);
  }, 60_000);

  test("add: low body-text contrast is a note, never a refusal; left-out colours are named", () => {
    const w = world();
    const out = w.run("add", w.file("dim.json", { plannotatorTheme: 1, id: "dim", name: "Dim", dark: { background: "#202020", foreground: "#4a4a4a" } }));
    expect(out.code).toBe(0);
    const [result, missing, contrast] = lines(out.stdout);
    expect(result).toStartWith('Added theme "Dim" (dim)');
    expect(missing).toStartWith("Note: the dark half does not set card, ");
    expect(contrast).toStartWith("Note: in the dark half, body text on the background is 1.");
    expect(w.themes()).toEqual(["dim.json"]);
  }, 60_000);

  test("use writes the halves a theme has to config.json, and refuses a half it lacks", () => {
    const w = world();
    w.run("add", join(fixtures, "instrument.plannotator-theme.json"));
    w.run("add", join(fixtures, "tomorrow-night.base16.yaml"));
    const both = w.run("use", "instrument");
    expect(both.code).toBe(0);
    expect(both.stdout).toContain("for the dark and light halves");
    expect(w.config().theme).toEqual({ light: "instrument", dark: "instrument" });
    expect(w.run("use", "tomorrow-night").code).toBe(0);
    expect(w.config().theme).toEqual({ light: "instrument", dark: "tomorrow-night" });
    const light = w.run("use", "tomorrow-night", "--light");
    expect(light.code).toBe(1);
    expect(light.stderr).toStartWith('no_such_half: "tomorrow-night" has no light half');
    expect(w.run("use", "nord", "--light").code).toBe(0);
    expect(w.config().theme.light).toBe("nord");
    const unknown = w.run("use", "nosuch");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toStartWith("not_found: ");
  }, 60_000);

  test("list --json and remove: the file moves aside and a half that used it goes back to Plannotator", () => {
    const w = world();
    w.run("add", join(fixtures, "tomorrow-night.base16.yaml"));
    w.run("use", "tomorrow-night");
    const listed = JSON.parse(w.run("list", "--json").stdout);
    expect(listed.custom).toEqual([{ id: "tomorrow-night", name: "Tomorrow Night", halves: ["dark"], in_use: ["dark"] }]);
    expect(listed.built_in).toHaveLength(55);
    const removed = w.run("remove", "tomorrow-night");
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("back on Plannotator");
    expect(w.themes()).toEqual([]);
    expect(readdirSync(join(w.dataDir, "themes", "removed"))).toHaveLength(1);
    expect(w.config().theme.dark).toBe("plannotator");
    expect(w.run("remove", "tomorrow-night").code).toBe(1);
    expect(w.run("remove", "dracula").stderr).toStartWith("built_in: ");
  }, 60_000);

  test("--help exits 0 with the usage; no subcommand or an unknown one is usage, exit 2", () => {
    const w = world();
    const help = w.run("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("plannotator theme add <file>");
    expect(w.run().code).toBe(2);
    expect(w.run("paint").code).toBe(2);
  }, 60_000);
});
