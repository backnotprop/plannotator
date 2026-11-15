import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitlabHostsSnapshot, learnGitlabHosts } from "@plannotator/core/forge-refs";
import { createGitlabHosts, glabConfigHosts } from "./inbox-gitlab-hosts";
import type { RefRunner } from "./ref-cards";

const TOKEN = "glpat-SECRET-never-read";

const GLAB_CONFIG = `# What protocol to use when performing git operations.
git_protocol: ssh
editor:
hosts:
    gitlab.com:
        api_protocol: https
        api_host: gitlab.com
        token: ${TOKEN}
        user: dev
    git.acme.com:
        api_protocol: https
        use_keyring: true
        user: dev
    "git.acme.com:8443":
        token: ${TOKEN}
    not a host:
        user: x
no_prompt: false
`;

const roots: string[] = [];
const learned = [...gitlabHostsSnapshot()];
afterEach(() => {
  learnGitlabHosts(learned);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the GitLab hosts glab knows", () => {
  test("only the host names under hosts: are read, never a value under them", () => {
    const hosts = glabConfigHosts(GLAB_CONFIG);
    expect(hosts).toEqual(["gitlab.com", "git.acme.com", "git.acme.com:8443"]);
    expect(JSON.stringify(hosts)).not.toContain("SECRET");
  });

  test("glab says where its file is; the older places and the config.json list are read too; glab is asked nothing about a host", async () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-glab-hosts-"));
    roots.push(root);
    const current = join(root, "Application Support", "glab-cli");
    const legacy = join(root, "xdg", "glab-cli");
    mkdirSync(current, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(current, "config.yml"), GLAB_CONFIG);
    writeFileSync(join(legacy, "config.yml"), "hosts:\n  source.acme.io:\n    user: dev\n");
    const calls: string[][] = [];
    const run: RefRunner = async (cli, args) => {
      calls.push([cli, ...args]);
      return { stdout: `${join(current, "config.yml")}\n`, stderr: "", exitCode: 0 };
    };
    const hosts = createGitlabHosts({ run, env: { XDG_CONFIG_HOME: join(root, "xdg") }, home: root, config: () => ({ gitlabHosts: ["Code.Acme.dev", "https://bad.example", 7 as never] }) });
    await hosts.refresh();
    expect([...gitlabHostsSnapshot()].sort()).toEqual(["code.acme.dev", "git.acme.com", "git.acme.com:8443", "gitlab.com", "source.acme.io"]);
    expect(calls).toEqual([["glab", "config", "path"]]);
  });
});
