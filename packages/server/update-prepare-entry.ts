import { runUpdatePrepareCommand } from "./update-prepare";

const argv = process.argv.slice(2);
process.exit(argv[0] === "update-prepare" ? await runUpdatePrepareCommand(argv.slice(1), { platform: process.platform }) : 2);
