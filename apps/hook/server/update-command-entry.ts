/**
 * `plannotator update` alone, without the CLI's other subcommands: the
 * process tests run this with `bun --define __CLI_VERSION__=...` because the
 * full entry (index.ts) imports the built HTML, which the test job does not
 * build. index.ts dispatches the same function.
 */
import { getCliVersion } from "./cli";
import { runUpdateCommand } from "./update-command";

process.exit(await runUpdateCommand(process.argv.slice(2), { currentVersion: getCliVersion() }));
