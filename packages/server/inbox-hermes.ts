import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HERMES_PLUGIN_NAME } from "@plannotator/core/inbox-hermes";
import type { AgentEnvironment } from "./inbox-agents";

export function hermesHome(e: AgentEnvironment): string {
  const given = e.env.HERMES_HOME?.trim();
  const path = given?.startsWith("~/") ? join(e.homeDir, given.slice(2)) : given;
  return path && isAbsolute(path) ? path : join(e.homeDir, ".hermes");
}

export function hermesFound(e: AgentEnvironment): boolean {
  try {
    return statSync(hermesHome(e)).isDirectory();
  } catch {
    return false;
  }
}

export function hermesWakeGranted(e: AgentEnvironment): boolean {
  try {
    const config = Bun.YAML.parse(readFileSync(join(hermesHome(e), "config.yaml"), "utf8")) as { plugins?: { entries?: Record<string, { allow_gateway_injection?: unknown } | null> } } | null;
    return config?.plugins?.entries?.[HERMES_PLUGIN_NAME]?.allow_gateway_injection === true;
  } catch {
    return false;
  }
}

export function hermesPluginInstalled(e: AgentEnvironment): boolean {
  try {
    const manifest = readFileSync(join(hermesHome(e), "plugins", HERMES_PLUGIN_NAME, "plugin.yaml"), "utf8");
    return /^name:\s*plannotator\s*$/m.test(manifest) && manifest.includes("backnotprop/plannotator");
  } catch {
    return false;
  }
}
