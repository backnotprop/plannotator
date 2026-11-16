import { describe, expect, test } from "bun:test";
import { forgeHostTrusted, parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { createRefCards, type RefCli, type RefRunner } from "./ref-cards";

const GLAB_SIGNED_IN = "git.acme.com\n  ✓ Logged in to git.acme.com as dev (keyring)\ngit.acme.com:8443\n  ✓ Logged in to git.acme.com:8443 as dev (keyring)\n";

function stubForges() {
  const calls: { cli: RefCli; args: string[] }[] = [];
  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    if (args[0] === "auth" && args[1] === "status") return cli === "glab" ? { stdout: "", stderr: GLAB_SIGNED_IN, exitCode: 0 } : { stdout: "{}", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "stub forge", exitCode: 1 };
  };
  return { run, calls };
}

const ROWS: [href: string, platform: "github" | "gitlab" | null, calls: boolean][] = [
  ["https://github.com/acme/api/pull/1", "github", true],
  ["https://gitlab.com/acme/api/-/merge_requests/1", "gitlab", true],
  ["https://gitlab.acme.com/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://code.gitlab.acme.com/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://git.acme.com/acme/api/-/merge_requests/1", "gitlab", true],
  ["https://git.acme.com/acme/sub/api/-/issues/12", "gitlab", true],
  ["https://source.acme.io/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://acme-gitlab.com/acme/api/-/work_items/3", "gitlab", false],
  ["https://git.acme.com:8443/acme/api/-/merge_requests/1", "gitlab", true],
  ["https://source.acme.io:8443/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://gitlab.evil.example/acme/api/-/merge_requests/1", "gitlab", false],
  ["https://evil.example/acme/api/-/merge_requests/1", "gitlab", false],
  ["http://git.acme.com/acme/api/-/merge_requests/1", null, false],
  ["http://gitlab.com/acme/api/-/merge_requests/1", null, false],
  ["https://gitlab.com:8443/acme/api/-/merge_requests/1", null, false],
  ["https://gitlab.com-evil.example/acme/api/-/merge_requests/1", null, false],
  ["https://git.acme.com/acme/api/-/blob/main/README.md", null, false],
  ["https://git.acme.com/acme/api/pull/1", null, false],
];

describe("which links are a forge's, and which hosts are asked", () => {
  test.each(ROWS)("%s → %p, asked: %p", async (href, platform, calls) => {
    const ref = parseForgeRefUrl(href);
    expect(ref?.platform ?? null).toBe(platform);
    const forges = stubForges();
    const cards = createRefCards({ run: forges.run, avatar: async () => null });
    const result = await cards.get(href);
    const host = new URL(href).host;
    const asked = forges.calls.some((call) => call.args.includes(host));
    expect(asked).toBe(calls);
    expect(ref ? forgeHostTrusted(ref, new Set(["git.acme.com", "git.acme.com:8443"])) : false).toBe(calls);
    if (ref && !calls) expect(result).toMatchObject({ ok: false, error: "unsupported" });
  });
});
