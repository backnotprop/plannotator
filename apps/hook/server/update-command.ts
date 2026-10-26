/**
 * `plannotator update [--check]`: install the newest stable release now.
 *
 * It runs the same thing as background auto-update and the Inbox's Update
 * now: the install script for the pinned tag with the remembered install
 * flags, under update.lock, logging to update.log and recording
 * update-result.json (packages/server/auto-update.ts). Here it runs in the
 * foreground so the person sees the installer's output as it happens.
 *
 * Asking GitHub is an explicit action, so it happens even when automatic
 * update checks are off (PLANNOTATOR_UPDATE_CHECK=0); it says so.
 *
 * Exit codes: 0 up to date, updated, or `--check`; 1 the update could not run
 * or failed; 2 usage.
 */

import { homedir } from "node:os";
import { loadConfig, parseUpdateCheckEnv, resolveUpdateCheck } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { readInboxRegistry } from "@plannotator/shared/inbox/registry";
import {
  CLAUDE_PLUGIN_UPDATE_COMMANDS,
  installCommandFor,
  installerFlagArgs,
  isNewerStableVersion,
  parseStableVersion,
  knownLatestRelease,
  readInstallFlags,
  readUpdateState,
  releaseUrlFor,
  runReleaseCheck,
  type FetchReleaseResult,
} from "@plannotator/shared/update-check";
import {
  autoUpdatePaths,
  beginManualUpdate,
  isManagedBinary,
  managedBinaryPath,
  runInstallerForeground,
  type InstallerLaunch,
} from "@plannotator/server/auto-update";
import { UPDATE_COMMAND_USAGE } from "./cli";

export interface UpdateCommandDeps {
  currentVersion: string | undefined;
  dataDir?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  out?: (text: string) => void;
  err?: (text: string) => void;
  fetchReleasePage?: () => Promise<FetchReleaseResult>;
  fetchRelease?: () => Promise<FetchReleaseResult>;
  runInstaller?: (launch: InstallerLaunch, write: (chunk: string) => void) => Promise<number>;
}

function checksOffSource(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = parseUpdateCheckEnv(env);
  if (fromEnv === false) return "PLANNOTATOR_UPDATE_CHECK=0";
  if (fromEnv === true) return null;
  return resolveUpdateCheck(loadConfig(), env) ? null : '{ "updateCheck": false } in config.json';
}

export async function runUpdateCommand(args: string[], deps: UpdateCommandDeps): Promise<number> {
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const err = deps.err ?? ((t: string) => process.stderr.write(t));
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const dataDir = deps.dataDir ?? getPlannotatorDataDir();
  const now = deps.now ?? Date.now;

  let checkOnly = false;
  for (const arg of args) {
    if (arg === "--check") checkOnly = true;
    else {
      err(`Unknown option: ${arg}\n\n${UPDATE_COMMAND_USAGE}\n`);
      return 2;
    }
  }

  const current = deps.currentVersion;
  const flags = readInstallFlags(dataDir).flags;
  const command = installCommandFor(platform, flags);
  if (!current || !parseStableVersion(current)) {
    err(
      "This is a development build of Plannotator (no release version), so there is nothing to update.\n" +
        `To install a release: ${command}\n`,
    );
    return 1;
  }

  const off = checksOffSource(env);
  if (off) err(`Update checks are off (${off}). Checking because you asked.\n`);

  const checked = await runReleaseCheck({
    dataDir,
    now,
    enabled: () => true,
    force: true,
    ...(deps.fetchReleasePage && { fetchReleasePage: deps.fetchReleasePage }),
    ...(deps.fetchRelease && { fetchRelease: deps.fetchRelease }),
  });
  if (checked.outcome === "failed") {
    // The install script finds the newest release on its own (the API, else
    // the release page), so it works when this check does not.
    err(
      `Could not ask GitHub for the latest release: ${checked.error}\n` +
        `To install the newest release anyway, run:\n  ${command}\n`,
    );
    return 1;
  }
  const latest = knownLatestRelease(readUpdateState(dataDir))?.version ?? null;
  if (!latest || !isNewerStableVersion(latest, current)) {
    out(`Plannotator ${current} is installed. Up to date (checked just now).\n`);
    return 0;
  }

  out(`Plannotator ${latest} is available (you have ${current}).\n`);
  if (checkOnly) {
    out(`Update: plannotator update\nWhat's new: ${releaseUrlFor(latest)}\n`);
    return 0;
  }

  const execPath = deps.execPath ?? process.execPath;
  const home = env.HOME || homedir();
  const managed = isManagedBinary(execPath, platform, env, home);
  const begun = beginManualUpdate({
    currentVersion: current,
    dataDir,
    now,
    platform,
    isManaged: () => managed,
  });
  if (begun.outcome === "unmanaged") {
    err(
      "This copy of Plannotator was not installed by the install script, so it can't update itself\n" +
        `(the install script manages ${managedBinaryPath(platform, env, home)}). Run:\n  ${command}\n`,
    );
    return 1;
  }
  if (begun.outcome === "locked") {
    err(`Another update is already running. Its output is in ${autoUpdatePaths(dataDir).log}\n`);
    return 1;
  }
  if (begun.outcome !== "ready") {
    out(`Plannotator ${current} is installed. Up to date.\n`);
    return 0;
  }

  const shown = installerFlagArgs(begun.launch.flags, platform);
  out(
    shown.length > 0
      ? `Installing v${latest} with your last install's choices: ${shown.join(" ")}\n`
      : `Installing v${latest}.\n`,
  );
  const run = deps.runInstaller ?? runInstallerForeground;
  const code = await run(begun.launch, out);
  if (code === 130) {
    err(
      `The update was interrupted. Plannotator is still ${current}; the lock is released, so run plannotator update again when you like.\n`,
    );
    return 130;
  }
  if (code !== 0) {
    err(
      `The update didn't install: the install script exited with code ${code}. Plannotator is still ${current}.\n` +
        `The log says what went wrong: ${autoUpdatePaths(dataDir).log}\n` +
        `Or run the install script yourself: ${command}\n`,
    );
    return 1;
  }
  out(`Updated to ${latest}. What's new: ${releaseUrlFor(latest)}\n`);
  out(
    readInboxRegistry(dataDir)
      ? `Open reviews keep running on ${current}. The Inbox shows Update to restart onto ${latest}.\n`
      : `Open reviews keep running on ${current}; new ones start on ${latest}.\n`,
  );
  if (begun.launch.flags.includes("skip-claude-plugin")) {
    out(`The Claude Code plugin updates separately: ${CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ")}\n`);
  }
  return 0;
}
