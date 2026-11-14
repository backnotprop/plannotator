/**
 * The preference list (inbox-prefs.ts). What regresses: a key that is not short, lower-case and dotted, or named
 * twice; an entry with no words; a default its own type refuses (so `reset` would write a value the route refuses);
 * a check letting through a value of the wrong type, a number out of range, a list with a stranger or a repeat; a
 * refusal that does not name the key and what it takes; one bad key in a call letting the others through; `reset`
 * writing a key with no default, or "all" reaching a secret; a secret's refusal repeating what came.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_PREFS, inboxPref, inboxPrefCheck, inboxPrefsChange } from "./inbox-prefs";

describe("the list", () => {
  test("every key is short, lower-case, dotted by area and named once", () => {
    const keys = INBOX_PREFS.map((pref) => pref.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z_]+\.[a-z0-9_-]+(\.[a-z_]+)?$/);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(40);
  });

  test("every entry has its words and a default its own type takes", () => {
    for (const pref of INBOX_PREFS) {
      expect(pref.label.length).toBeGreaterThan(0);
      expect(pref.meaning.length).toBeGreaterThan(0);
      expect(pref.where.length).toBeGreaterThan(0);
      expect(inboxPrefCheck(pref, pref.default)).toEqual({ ok: true, value: pref.default });
    }
  });

  test("a cloud agent's wake key is known by its id, and only a well-formed one", () => {
    expect(inboxPref("cloud_agents.0123456789ab.wake")).toMatchObject({ group: "cloud_agents", secret: true, noReset: true });
    expect(inboxPref("cloud_agents.0123.wake")).toBeUndefined();
    expect(inboxPref("cloud_agents.0123456789ab.key")).toBeUndefined();
  });
});

describe("a value against its type", () => {
  const cases: [key: string, value: unknown, ok: boolean][] = [
    ["appearance.theme", "light", true],
    ["appearance.theme", "blue", false],
    ["appearance.theme", null, false],
    ["appearance.text_size", 15, true],
    ["appearance.text_size", 16, false],
    ["appearance.text_size", 14.5, false],
    ["appearance.text_size", "14", false],
    ["appearance.light_palette", "plannotator-graphite", true],
    ["appearance.light_palette", "Not An Id", false],
    ["sound.volume", 10, true],
    ["sound.volume", 9, false],
    ["sound.on", "true", false],
    ["sidebar.hidden", ["board", "usage"], true],
    ["sidebar.hidden", ["inbox"], false],
    ["sidebar.hidden", ["board", "board"], false],
    ["sidebar.top", ["inbox", "search"], true],
    ["sidebar.top", ["starred"], false],
    ["list.rows", ["compact", "hidePulls"], true],
    ["list.rows", ["sparkles"], false],
    ["reactions.saved", [{ emoji: "🎉", label: "ship" }, { emoji: "👀" }], true],
    ["reactions.saved", [{ emoji: "🎉", color: "red" }], false],
    ["reactions.saved", Array.from({ length: 6 }, () => ({ emoji: "🎉" })), false],
    ["prompts.rules", null, true],
    ["prompts.rules", "x".repeat(9001), false],
    ["diff.tab_size", 8, true],
    ["diff.tab_size", 0, false],
    ["reviews.risk_rules", null, false],
    ["access.tailnet_allow", ["friend@example.com"], true],
    ["access.tailnet_allow", ["two words"], false],
    ["access.tailnet_allow", ["Friend@example.com", "friend@example.com"], false],
    ["cloud_agents.0123456789ab.wake", { url: "https://example.com/hook", key: "k1" }, true],
    ["cloud_agents.0123456789ab.wake", { url: "https://example.com/hook" }, false],
    ["voice.api_key", "sk-a-real-looking-key", true],
    ["voice.api_key", "short", false],
  ];
  for (const [key, value, ok] of cases) {
    test(`${key} = ${JSON.stringify(value)?.slice(0, 40)}: ${ok ? "taken" : "refused"}`, () => {
      const checked = inboxPrefCheck(inboxPref(key)!, value);
      expect(checked.ok).toBe(ok);
      if (!checked.ok) expect((checked as { error: string }).error.startsWith(`${key}: `)).toBe(true);
    });
  }

  test("a refusal says what the key takes", () => {
    expect((inboxPrefCheck(inboxPref("appearance.theme")!, "blue") as { error: string }).error).toBe('appearance.theme: light, dark or system (got "blue").');
    expect((inboxPrefCheck(inboxPref("sound.volume")!, 101) as { error: string }).error).toBe("sound.volume: a whole number from 10 to 100 (got 101).");
  });

  test("a secret's refusal never repeats what came", () => {
    const voice = inboxPrefCheck(inboxPref("voice.api_key")!, "sk two words secret-1234");
    expect(JSON.stringify(voice)).not.toContain("secret-1234");
    const wake = inboxPrefCheck(inboxPref("cloud_agents.0123456789ab.wake")!, { url: 5, key: "secret-1234" });
    expect(JSON.stringify(wake)).not.toContain("secret-1234");
  });
});

describe("a call's set and reset", () => {
  test("several keys are taken together", () => {
    const change = inboxPrefsChange({ set: { "appearance.theme": "light", "appearance.text_size": 15, "sidebar.hidden": ["usage"] } });
    expect(change.ok).toBe(true);
    if (change.ok) expect([...change.values].map(([pref, value]) => [pref.key, value])).toEqual([["appearance.theme", "light"], ["appearance.text_size", 15], ["sidebar.hidden", ["usage"]]]);
  });

  test("one bad value refuses the whole call, naming that key", () => {
    expect(inboxPrefsChange({ set: { "appearance.theme": "light", "appearance.text_size": 22 } })).toMatchObject({ ok: false, status: 422, code: "validation_error", key: "appearance.text_size" });
  });

  test("a key the list does not know refuses the call", () => {
    expect(inboxPrefsChange({ set: { "appearance.theme": "light", "appearance.font": "serif" } })).toMatchObject({ ok: false, status: 422, code: "unknown_pref", key: "appearance.font" });
  });

  test("the keys an agent once could not set are set like any other", () => {
    expect(inboxPrefsChange({ set: { "launch.full_permissions": true, "access.tailnet_window": true, "access.this_wifi": true } }).ok).toBe(true);
  });

  test("reset puts the default; a key with none is refused", () => {
    const change = inboxPrefsChange({ reset: ["appearance.text_size", "prompts.rules"] });
    expect(change.ok && [...change.values].map(([pref, value]) => [pref.key, value])).toEqual([["appearance.text_size", 14], ["prompts.rules", null]]);
    expect(inboxPrefsChange({ reset: ["agents.codex.reach"] })).toMatchObject({ ok: false, key: "agents.codex.reach" });
  });

  test('reset "all" leaves the keys with no default and the secrets; a reset naming a secret removes it', () => {
    const change = inboxPrefsChange({ reset: "all" });
    expect(change.ok).toBe(true);
    if (!change.ok) return;
    const keys = [...change.values.keys()].map((pref) => pref.key);
    expect(keys).toContain("appearance.theme");
    expect(keys.some((key) => key.endsWith(".reach") || key.endsWith(".note"))).toBe(false);
    expect(keys).not.toContain("voice.api_key");
    expect(keys.length).toBe(INBOX_PREFS.filter((pref) => !pref.noReset && !pref.secret).length);
    const named = inboxPrefsChange({ reset: ["voice.api_key"] });
    expect(named.ok && [...named.values.values()]).toEqual([null]);
  });

  test("a key both set and reset, an empty call and a bad shape are refused", () => {
    expect(inboxPrefsChange({ set: { "sound.on": false }, reset: ["sound.on"] })).toMatchObject({ ok: false, key: "sound.on" });
    expect(inboxPrefsChange({})).toMatchObject({ ok: false, status: 422 });
    expect(inboxPrefsChange({ set: ["sound.on"] })).toMatchObject({ ok: false, status: 422 });
    expect(inboxPrefsChange({ reset: "everything" })).toMatchObject({ ok: false, status: 422 });
  });
});
