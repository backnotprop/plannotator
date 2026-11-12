import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_CODEX_MODEL = "gpt-fake-discovered";

export function fakeAgentClis(dir: string): { codexMarker: string } {
  const codexMarker = join(dir, "codex-ran");
  const server = join(dir, "fake-codex-app-server.mjs");
  writeFileSync(
    server,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(codexMarker)}, "ran\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const result = msg.method === "initialize"
      ? { userAgent: "plannotator/0.999.0 (Linux; x86_64)" }
      : msg.method === "model/list"
        ? { data: [{ id: ${JSON.stringify(FAKE_CODEX_MODEL)}, displayName: "GPT Fake Discovered", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], additionalSpeedTiers: [] }] }
        : null;
    const reply = result ? { id: msg.id, result } : { id: msg.id, error: { code: -1, message: "unsupported" } };
    process.stdout.write(JSON.stringify(reply) + "\\n");
  }
});
`,
  );
  const codex = join(dir, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`);
  chmodSync(codex, 0o755);

  const claude = join(dir, "claude");
  writeFileSync(claude, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\nexit 1\n');
  chmodSync(claude, 0o755);

  return { codexMarker };
}
