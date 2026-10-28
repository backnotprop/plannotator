/**
 * `update-prepare` alone, for the POSIX wrapper tests: they point the
 * wrapper's PLANNOTATOR_UPDATE_BINARY / PLANNOTATOR_UPDATE_ENTRY at
 * `bun <this file>`, since the compiled binary is not built in the test job.
 */
import { runUpdatePrepareCommand } from "./update-prepare";

const argv = process.argv.slice(2);
process.exit(argv[0] === "update-prepare" ? await runUpdatePrepareCommand(argv.slice(1), { platform: process.platform }) : 2);
