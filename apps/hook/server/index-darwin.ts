/**
 * The macOS entry of the compiled CLI: the same CLI, plus the zipped
 * "Plannotator Snapshots.app" embedded in the binary. `plannotator snapshot`
 * installs it into ~/Applications when its build differs from the installed
 * one (snapshot-command.ts). Built only on macOS release jobs, after
 * apps/snapshots-macos/build.sh produced dist/PlannotatorSnapshots.zip.
 */

// @ts-ignore - Bun import attribute for an embedded file
import snapshotsAppZip from "../../snapshots-macos/dist/PlannotatorSnapshots.zip" with { type: "file" };
// @ts-ignore - Bun import attribute for text
import snapshotsAppBuild from "../../snapshots-macos/dist/build.txt" with { type: "text" };

globalThis.__PLANNOTATOR_SNAPSHOTS_APP_ZIP__ = snapshotsAppZip as unknown as string;
globalThis.__PLANNOTATOR_SNAPSHOTS_APP_BUILD__ = (snapshotsAppBuild as unknown as string).trim();

await import("./index");
