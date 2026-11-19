/**
 * The "Agent status" setting's store (inbox-agent-status-setting.ts): config.json `inboxAgentStatus`, as
 * `POST /api/inbox/settings` `{ agent_status: { on } }` writes it. The failures these guard: on by default (the owner:
 * off by default), a save that is not kept, a malformed save written anyway, a check-only pass that writes, a
 * config.json that refused the write reported as saved, config.json read and parsed again while it has not changed
 * (the 1 s delivery watch asks: review L1), or a change to it not seen. A config held in memory: no server, no real config.json.
 */
import { describe, expect, test } from "bun:test";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { createInboxAgentStatusSetting } from "./inbox-agent-status-setting";

function setting(initial: Pick<PlannotatorConfig, "inboxAgentStatus"> = {}, refuse = false) {
  let config = { ...initial };
  const writes: unknown[] = [];
  const it = createInboxAgentStatusSetting({
    loadConfig: () => config,
    saveConfig: (change) => {
      writes.push(change);
      if (!refuse) config = { ...config, ...change };
    },
  });
  return { it, writes, config: () => config };
}

describe("Agent status setting", () => {
  test("off when never set; a save turns it on and off, and is kept", () => {
    const { it, config } = setting();
    expect(it.on()).toBe(false);
    expect(it.save({ on: true })).toEqual({ on: true });
    expect(config().inboxAgentStatus).toBe(true);
    expect(it.on()).toBe(true);
    expect(it.save({ on: false })).toEqual({ on: false });
    expect(it.on()).toBe(false);
  });

  test("anything but { on: boolean } is refused and nothing is written; a check-only pass writes nothing", () => {
    const { it, writes } = setting();
    for (const bad of [true, null, [], { on: "yes" }, { on: true, extra: 1 }]) expect(() => it.save(bad)).toThrow("agent_status: { on: boolean }.");
    expect(it.save({ on: true }, true)).toEqual({ on: false });
    expect(writes).toEqual([]);
  });

  test("a config.json that refused the write: an error, not a saved switch", () => {
    const { it } = setting({}, true);
    expect(() => it.save({ on: true })).toThrow("config.json could not be saved");
  });
});

describe("Agent status setting, read with config.json's stat", () => {
  test("parsed again only when the file changed", () => {
    let reads = 0;
    let key = "1:10";
    let config: Pick<PlannotatorConfig, "inboxAgentStatus"> = { inboxAgentStatus: true };
    const it = createInboxAgentStatusSetting({
      loadConfig: () => (reads++, config),
      saveConfig: (change) => {
        config = { ...config, ...change };
        key = "2:11";
      },
      configKey: () => key,
    });
    for (let i = 0; i < 5; i++) expect(it.on()).toBe(true);
    expect(reads).toBe(1);
    // Changed outside (edited by hand, another process): a new stat, read again.
    config = { inboxAgentStatus: false };
    key = "3:11";
    expect(it.on()).toBe(false);
    expect(reads).toBe(2);
    expect(it.save({ on: true })).toEqual({ on: true });
    expect(it.on()).toBe(true);
  });
});
