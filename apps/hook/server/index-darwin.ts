/**
 * The macOS entry of the compiled CLI: the same CLI, plus the zipped
 * "Plannotator Shots.app" embedded in the binary. `plannotator screenshot`
 * installs it into ~/Applications when its build differs from the installed
 * one (shots-command.ts). Built only on macOS release jobs, after
 * apps/shots-macos/build.sh produced dist/PlannotatorShots.zip.
 */

// @ts-ignore - Bun import attribute for an embedded file
import shotsAppZip from "../../shots-macos/dist/PlannotatorShots.zip" with { type: "file" };
// @ts-ignore - Bun import attribute for text
import shotsAppBuild from "../../shots-macos/dist/build.txt" with { type: "text" };

globalThis.__PLANNOTATOR_SHOTS_APP_ZIP__ = shotsAppZip as unknown as string;
globalThis.__PLANNOTATOR_SHOTS_APP_BUILD__ = (shotsAppBuild as unknown as string).trim();

await import("./index");
