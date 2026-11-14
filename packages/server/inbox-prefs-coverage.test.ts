/**
 * Keeps the preference list (core inbox-prefs.ts) from falling behind the settings routes.
 *
 * It fails when:
 * - a field the settings route reads from its body (`body.<field>` in inbox.ts's POST /api/inbox/settings) is not on
 *   `INBOX_SETTINGS_FIELDS`, or a field there is neither a key's field nor on `INBOX_SETTINGS_NOT_PREFS` with a reason;
 * - a field Settings → Agents' or launch's settings route reads has no key (or one a key names is gone);
 * - a diff display field (`INBOX_DIFF_OPTION_FIELDS`) has no key;
 * - a key's `stored` names a config.json field `PlannotatorConfig` no longer has;
 * - the list's agent hosts or tool defaults drift from shared/config.ts's.
 *
 * It cannot catch: a new field inside an object field (`sound.fade`) whose parser keeps its list in a closure; a new
 * settings route other than the ones the list names (a new field of the phones' doors, the voice key or a cloud
 * agent's wake is not looked for); a browser-only setting (a cookie the window keeps); a value saved under the
 * same field name with a new meaning. inbox-prefs-route.test.ts writes every key through the real routes and reads
 * config.json back, which catches a key whose route no longer saves where `stored` says.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PREF_REMINDER_HOSTS, INBOX_PREF_TOOL_HOSTS, INBOX_PREFS } from "@plannotator/core/inbox-prefs";
import { INBOX_REMINDER_HOSTS, INBOX_TOOL_DEFAULTS, INBOX_TOOL_HOSTS } from "@plannotator/shared/config";
import { INBOX_DIFF_OPTION_FIELDS } from "./inbox-diff-options";
import { INBOX_SETTINGS_FIELDS, INBOX_SETTINGS_NOT_PREFS, inboxPrefBinding } from "./inbox-prefs";

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "..", path), "utf8");

/** The text of one route's block: from its `if (path === …)` line to the next line at that indent that closes it. */
function routeBlock(text: string, opening: string): string {
  const start = text.indexOf(opening);
  if (start < 0) throw new Error(`no ${opening}`);
  const indent = text.slice(text.lastIndexOf("\n", start) + 1, start);
  const end = text.indexOf(`\n${indent}}`, start);
  return text.slice(start, end);
}

const bindings = INBOX_PREFS.map((pref) => ({ pref, binding: inboxPrefBinding(pref.key)! }));
const fieldsOf = (route: string) => new Set(bindings.filter((b) => b.binding.route === route).map((b) => b.binding.field));

describe("POST /api/inbox/settings", () => {
  const block = routeBlock(source("packages/server/inbox.ts"), 'if (path === "/api/inbox/settings") {');

  test("every field the route reads is on INBOX_SETTINGS_FIELDS", () => {
    const read = new Set([...block.matchAll(/\bbody\.([a-z_]+)/g)].map((m) => m[1]!));
    expect(read.size).toBeGreaterThan(20);
    expect([...read].filter((field) => !(INBOX_SETTINGS_FIELDS as readonly string[]).includes(field))).toEqual([]);
  });

  test("every field there is a key's, or says why it is not a preference", () => {
    const keyed = fieldsOf("settings");
    // Settings → Agents' tool switch writes inbox_tool too; the list goes through that route.
    const missing = INBOX_SETTINGS_FIELDS.filter((field) => !keyed.has(field) && !(field in INBOX_SETTINGS_NOT_PREFS));
    expect(missing).toEqual([]);
    for (const field of keyed) expect(INBOX_SETTINGS_FIELDS as readonly string[]).toContain(field);
  });

  test("every diff display field has a key", () => {
    const wires = new Set(bindings.filter((b) => b.binding.field === "diff_options").map((b) => b.pref.key));
    expect(wires.size).toBe(Object.keys(INBOX_DIFF_OPTION_FIELDS).length);
  });
});

describe("the other routes", () => {
  test("Settings → Agents: each switch the route takes has its keys", () => {
    const block = routeBlock(source("packages/server/inbox.ts"), "const saveAgent = async");
    const switches = /for \(const field of \[([^\]]+)\] as const\)/.exec(block)![1]!.match(/"([a-z]+)"/g)!.map((s) => s.slice(1, -1));
    expect(switches.sort()).toEqual([...fieldsOf("agents")].sort());
  });

  test("launch's settings: each field the route takes has a key", () => {
    const block = routeBlock(source("packages/server/inbox-launch.ts"), 'if (match[1] === "settings") {');
    const read = new Set([...block.matchAll(/"([a-z_]+)" in body|\bbody\.([a-z_]+)/g)].map((m) => m[1] ?? m[2]!));
    expect([...read].sort()).toEqual([...fieldsOf("launch")].sort());
  });
});

describe("where each key is stored", () => {
  test("a config.json field a key names is still a PlannotatorConfig field", () => {
    const text = source("packages/shared/config.ts");
    const start = text.indexOf("export interface PlannotatorConfig {");
    const body = text.slice(start, text.indexOf("\n}", start));
    const fields = new Set([...body.matchAll(/^ {2}([A-Za-z]+)\?:/gm)].map((m) => m[1]!));
    const missing = INBOX_PREFS.filter((pref) => !pref.stored.startsWith("file:") && !fields.has(pref.stored.split(".")[0]!)).map((pref) => pref.key);
    expect(missing).toEqual([]);
  });

  test("the hosts and tool defaults are shared/config.ts's", () => {
    expect([...INBOX_PREF_TOOL_HOSTS]).toEqual([...INBOX_TOOL_HOSTS]);
    expect([...INBOX_PREF_REMINDER_HOSTS]).toEqual([...INBOX_REMINDER_HOSTS]);
    for (const host of INBOX_PREF_TOOL_HOSTS) expect(INBOX_PREFS.find((pref) => pref.key === `agents.${host}.tool`)!.default).toBe(INBOX_TOOL_DEFAULTS[host]);
  });
});
