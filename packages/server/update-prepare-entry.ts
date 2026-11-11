/** `update-prepare` alone: the POSIX wrapper tests run it as `bun <this file>`, since the compiled binary is not built in the test job. */
import { runUpdatePrepareCommand } from "./update-prepare";

const argv = process.argv.slice(2);
process.exit(argv[0] === "update-prepare" ? await runUpdatePrepareCommand(argv.slice(1), { platform: process.platform }) : 2);
