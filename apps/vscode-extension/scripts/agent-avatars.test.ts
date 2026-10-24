import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ICONS_SOURCE, AVATAR_DIR, buildAgentAvatars } from "./agent-avatars";

describe("the agents' avatars in the question box", () => {
  it("are the web app's agent marks, rebuilt (bun scripts/agent-avatars.ts) when a mark changes", () => {
    const built = buildAgentAvatars(readFileSync(AGENT_ICONS_SOURCE, "utf8"));
    expect(Object.keys(built).sort()).toEqual(["claude-code", "codex", "copilot", "cursor", "opencode", "pi"]);
    for (const a of Object.values(built)) {
      const onDisk = readFileSync(join(AVATAR_DIR, a.file));
      expect(Buffer.compare(onDisk, Buffer.from(a.content))).toBe(0);
    }
  });
});
