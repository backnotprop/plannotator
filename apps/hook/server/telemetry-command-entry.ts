/**
 * `plannotator telemetry` alone, without the CLI's other subcommands: the
 * process tests run this (with `bun --define __CLI_VERSION__=...` when they
 * need a release build) because the full entry (index.ts) imports the built
 * HTML, which the test job does not build. index.ts dispatches the same function.
 */
import { getCliVersion } from "./cli";
import { runTelemetryCommand } from "./telemetry-command";

process.exit(await runTelemetryCommand(process.argv.slice(2), { version: getCliVersion() }));
