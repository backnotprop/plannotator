import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { classifyForgeHost, learnGitlabHosts, normalizeForgeHost } from "@plannotator/core/forge-refs";
import { loadConfig, type PlannotatorConfig } from "@plannotator/shared/config";
import { REF_AUTH_HOSTS_MS, refCliRunner, type RefRunner } from "./ref-cards";

const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;

export function gitlabHostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
  return HOST.test(host) ? host : null;
}

export function unnamedForgeHost(host: string | null | undefined): boolean {
  const name = normalizeForgeHost(host);
  return !!name && classifyForgeHost(name) === null;
}

export function glabConfigHosts(yaml: string): string[] {
  const hosts: string[] = [];
  let inHosts = false;
  let indent: number | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    const text = line.trimStart();
    if (!text || text.startsWith("#")) continue;
    const lead = line.length - text.length;
    if (lead === 0) {
      inHosts = /^hosts:\s*$/.test(line);
      indent = null;
      continue;
    }
    if (!inHosts) continue;
    indent ??= lead;
    if (lead !== indent) continue;
    const key = /^(.+):\s*$/.exec(text.trimEnd())?.[1];
    const host = key ? gitlabHostName(key) : null;
    if (host) hosts.push(host);
  }
  return hosts;
}

export function settingGitlabHosts(config: Pick<PlannotatorConfig, "gitlabHosts">): string[] {
  return Array.isArray(config.gitlabHosts) ? config.gitlabHosts.flatMap((value) => gitlabHostName(value) ?? []) : [];
}

export async function glabConfigFiles(run: RefRunner, env: Record<string, string | undefined>, home: string): Promise<string[]> {
  const files = new Set<string>();
  const said = await run("glab", ["config", "path"], { GLAB_CHECK_UPDATE: "false" }).catch(() => null);
  const path = said?.exitCode === 0 ? said.stdout.trim() : "";
  if (path && isAbsolute(path) && !path.includes("\n")) files.add(path);
  if (env.GLAB_CONFIG_DIR) files.add(join(env.GLAB_CONFIG_DIR, "config.yml"));
  files.add(join(env.XDG_CONFIG_HOME || join(home, ".config"), "glab-cli", "config.yml"));
  return [...files];
}

export interface GitlabHosts {
  refresh(): Promise<void>;
}

export function createGitlabHosts(options: {
  run?: RefRunner;
  env?: Record<string, string | undefined>;
  home?: string;
  read?: (path: string) => Promise<string>;
  config?: () => Pick<PlannotatorConfig, "gitlabHosts">;
  now?: () => number;
} = {}): GitlabHosts {
  const run = options.run ?? refCliRunner;
  const read = options.read ?? ((path: string) => readFile(path, "utf8"));
  const config = options.config ?? (() => loadConfig({ quiet: true }));
  const now = options.now ?? Date.now;
  let at = -Infinity;
  let reading: Promise<void> | null = null;
  return {
    refresh() {
      if (reading) return reading;
      if (now() - at < REF_AUTH_HOSTS_MS) return Promise.resolve();
      reading = (async () => {
        const found = new Set<string>();
        for (const file of await glabConfigFiles(run, options.env ?? process.env, options.home ?? homedir())) {
          for (const host of glabConfigHosts(await read(file).catch(() => ""))) found.add(host);
        }
        for (const host of settingGitlabHosts(config())) found.add(host);
        learnGitlabHosts(found);
        at = now();
      })().finally(() => {
        reading = null;
      });
      return reading;
    },
  };
}
