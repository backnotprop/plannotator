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
 * or failed (including a download that did not match its checksum, or one
 * that could not be downloaded: the old binary is kept either way); 2 usage.
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
  UPDATE_CHECKSUM_MISMATCH,
  UPDATE_PREPARE_FAILED,
  type InstallerLaunch,
} from "@plannotator/server/auto-update";
import { stagingFailureIn, tlsFailureIn, withoutLogOnlyLines } from "@plannotator/server/update-log";
import { UPDATE_OTHER_TMPDIR_COMMAND, updateStagingAdvice } from "@plannotator/core/update-exit-codes";
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
  let printed = "";
  const code = await run(begun.launch, (text) => {
    printed += text;
    // Notes meant for update.log only (the tee still writes them there).
    const shown = withoutLogOnlyLines(text);
    if (shown) out(shown);
  });
  if (code === 130) {
    err(
      `The update was interrupted. Plannotator is still ${current}; the lock is released, so run plannotator update again when you like.\n`,
    );
    return 130;
  }
  // Safe updates: never the `curl | bash` line here. After a mismatch it
  // would send the person through the very connection that just failed.
  if (code === UPDATE_CHECKSUM_MISMATCH) {
    err(
      `The update to ${latest} stopped: the download didn't match the checksum Plannotator fetched for it.\n` +
        `${current} is still installed and works. Try again later, or on another network: plannotator update\n` +
        `Details: ${autoUpdatePaths(dataDir).log}\n`,
    );
    return 1;
  }
  if (code === UPDATE_PREPARE_FAILED) {
    const staging = stagingFailureIn(printed);
    if (staging) {
      // Downloaded, but the temp folder could not hold it: not a network problem.
      err(
        `Couldn't prepare the update: ${staging}. ${current} is still installed and works.\n` +
          `${updateStagingAdvice(staging)}, then: plannotator update\n` +
          `Or use another temp folder:\n  ${UPDATE_OTHER_TMPDIR_COMMAND}\n` +
          `Details: ${autoUpdatePaths(dataDir).log}\n`,
      );
      return 1;
    }
    const tls = tlsFailureIn(printed);
    if (tls === "revoked") {
      // A blocked key: the network is the problem, and curl would trust it.
      err(
        `Couldn't download the update: the connection presented a revoked certificate. ${current} is still installed and works.\n` +
          `Don't install Plannotator over this network. Try again on another network: plannotator update\n` +
          `Details: ${autoUpdatePaths(dataDir).log}\n`,
      );
      return 1;
    }
    // A failed download can be a lasting local condition (a proxy, a network
    // that inspects HTTPS), so the way out is always shown.
    const extraCa =
      "If your network inspects HTTPS with its own certificate, point NODE_EXTRA_CA_CERTS at that certificate:\n" +
      "  NODE_EXTRA_CA_CERTS=/path/to/its-root.pem plannotator update\n";
    if (tls === "untrusted" && platform === "darwin") {
      // macOS curl still trusts emSign G3: should a network that holds a
      // leaked key get "untrusted" instead of "revoked", the release page
      // (the browser's own trust) comes before the `curl | bash` line.
      err(
        `Couldn't download the update. ${current} is still installed and works. Try again later: plannotator update\n` +
          extraCa +
          `If this keeps happening, download it from ${releaseUrlFor(latest)}\n` +
          `or install it yourself:\n  ${command}\n` +
          `Details: ${autoUpdatePaths(dataDir).log}\n`,
      );
      return 1;
    }
    err(
      `Couldn't download the update. ${current} is still installed and works. Try again later: plannotator update\n` +
        `If this keeps happening, install it yourself:\n  ${command}\n` +
        `or download it from ${releaseUrlFor(latest)}\n` +
        (tls === "untrusted" ? extraCa : "") +
        `Details: ${autoUpdatePaths(dataDir).log}\n`,
    );
    return 1;
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
