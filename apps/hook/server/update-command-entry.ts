import { runUpdatePrepareCommand } from "@plannotator/server/update-prepare";
import { getCliVersion } from "./cli";
import { runUpdateCommand } from "./update-command";

const argv = process.argv.slice(2);
process.exit(
  argv[0] === "update-prepare"
    ? await runUpdatePrepareCommand(argv.slice(1), { platform: process.platform })
    : await runUpdateCommand(argv, { currentVersion: getCliVersion() }),
);
