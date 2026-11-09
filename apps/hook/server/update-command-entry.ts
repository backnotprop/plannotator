/**
 * `plannotator update` alone, without the CLI's other subcommands: the
 * process tests run this with `bun --define __CLI_VERSION__=...` because the
 * full entry (index.ts) imports the built HTML, which the test job does not
 * build. index.ts dispatches the same function.
 */
import { runUpdatePrepareCommand } from "@plannotator/server/update-prepare";
import { getCliVersion } from "./cli";
import { runUpdateCommand } from "./update-command";

// The update wrapper calls back into its binary for `update-prepare`; a
// source run passes this entry (updatePrepareInvocation), so it answers too.
const argv = process.argv.slice(2);
process.exit(
  argv[0] === "update-prepare"
    ? await runUpdatePrepareCommand(argv.slice(1), { platform: process.platform })
    : await runUpdateCommand(argv, { currentVersion: getCliVersion() }),
);
