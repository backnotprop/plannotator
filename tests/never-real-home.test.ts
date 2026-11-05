/**
 * An Inbox or binary a test starts never gets the runner's real home. A temp
 * PLANNOTATOR_DATA_DIR and the agent sandbox do not cover it: `~/.agents/skills`
 * and `~/.env` are still read through HOME. An env with no HOME or an empty one
 * counts as real, because `os.homedir()` then falls back to the account's home.
 *
 * Most specs start the binary with their own `spawnSync`, so no helper sees that
 * env before the start. The scan covers those; `refuseRealHome` covers
 * `SimAgent.connect`, which most of them also go through. Nothing here starts an Inbox.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SimAgent } from "../scripts/inbox-sim";
import { refuseRealHome } from "./helpers/inbox-process";
import { accountHome } from "./helpers/real-data-dir";
import { stripComments } from "./helpers/real-inbox-scan";

const repo = resolve(import.meta.dir, "..");
const scratch = join(process.env.PLANNOTATOR_DATA_DIR!, "home");

/** The text of the `{ ... }` holding `at`, by brace count (an env literal's `${x}` is balanced). */
function enclosingObject(text: string, at: number): string {
  let start = at;
  for (let depth = 0; start > 0; start--) {
    if (text[start - 1] === "}") depth++;
    if (text[start - 1] === "{" && depth-- === 0) break;
  }
  let end = at;
  for (let depth = 0; end < text.length; end++) {
    if (text[end] === "{") depth++;
    if (text[end] === "}" && depth-- === 0) break;
  }
  return text.slice(start, end);
}

/** Each env literal that names a data dir but leaves HOME to the runner, as `<line>: <what>`. */
function realHomeFindings(source: string): string[] {
  const text = stripComments(source);
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const found: string[] = [];
  for (const m of text.matchAll(/\bprocess\.env\.HOME\b/g)) found.push(`${lineOf(m.index)}: passes the runner's HOME on`);
  for (const m of text.matchAll(/\bPLANNOTATOR_DATA_DIR\s*:/g)) {
    const literal = enclosingObject(text, m.index);
    if (/(^|[\s,{])HOME\s*[:,}]/.test(literal)) continue;
    // A spread of a world's own env brings its scratch HOME; a spread of process.env brings the real one.
    if (/\.\.\.\s*(?!process\.env\b)[\w.]*(?:env|Env)\b/.test(literal)) continue;
    found.push(`${lineOf(m.index)}: an env with a data dir and no HOME`);
  }
  return found;
}

describe("refuseRealHome", () => {
  test("refuses the account's home, no HOME and an empty HOME", () => {
    for (const home of [accountHome()!, undefined, "", "  "]) expect(() => refuseRealHome(home, "test")).toThrow("HOME must be a scratch folder");
  });

  test("lets a scratch folder through", () => {
    expect(refuseRealHome(scratch, "test")).toBe(scratch);
  });

  test("SimAgent.connect refuses before it starts anything", async () => {
    // A program that is not Plannotator: even without the guard, no Inbox could start here.
    const options = { binary: "/usr/bin/false", name: "x", host: "x" };
    const env = { PATH: "/usr/bin:/bin", PLANNOTATOR_DATA_DIR: process.env.PLANNOTATOR_DATA_DIR! };
    await expect(SimAgent.connect({ ...options, env })).rejects.toThrow("HOME must be a scratch folder");
    await expect(SimAgent.connect({ ...options, env: { ...env, HOME: accountHome()! } })).rejects.toThrow("HOME must be a scratch folder");
  });
});

describe("the e2e env literals", () => {
  test("the scan reads each way of leaving HOME to the runner", () => {
    expect(realHomeFindings("const env = { PATH: p, PLANNOTATOR_DATA_DIR: d };")).toHaveLength(1);
    expect(realHomeFindings("const env = { ...process.env, PLANNOTATOR_DATA_DIR: d };")).toHaveLength(1);
    expect(realHomeFindings("const env = { ...(process.env.HOME ? { HOME: process.env.HOME } : {}), PLANNOTATOR_DATA_DIR: d };")).not.toHaveLength(0);
    expect(realHomeFindings("const env = { PATH: p, HOME: root, PLANNOTATOR_DATA_DIR: d };")).toEqual([]);
    expect(realHomeFindings("const env = { ...fake.env, PLANNOTATOR_DATA_DIR: d };")).toEqual([]);
  });

  test("every spec gives its Inbox a scratch HOME", () => {
    const files = [
      ...readdirSync(join(repo, "tests/e2e")).filter((name) => name.endsWith(".ts")).map((name) => join("tests/e2e", name)),
      "scripts/inbox-sim.ts",
    ];
    const findings = files.flatMap((file) => realHomeFindings(readFileSync(join(repo, file), "utf8")).map((finding) => `${file}:${finding}`));
    expect(findings).toEqual([]);
  });
});
