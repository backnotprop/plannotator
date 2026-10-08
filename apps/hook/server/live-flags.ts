/**
 * The annotate subcommand's live-app flags: `--app` forces live app
 * annotation, `--static` forces the classic conversion pipeline.
 *
 * They belong to `annotate` only. Another subcommand may own a flag with the
 * same spelling (`plannotator snapshot --app` takes an App Capture), so the
 * global flag pass must leave those subcommands' argv alone.
 */

const LIVE_FLAGS: ReadonlySet<string> = new Set(["--app", "--static"]);

export interface AnnotateLiveFlags {
  app: boolean;
  static: boolean;
}

/**
 * When the subcommand is `annotate`, removes every `--app` and `--static` from
 * `args` (in place) and reports which were present. For any other subcommand
 * `args` is left untouched and both flags read as absent.
 */
export function takeAnnotateLiveFlags(args: string[]): AnnotateLiveFlags {
  const flags: AnnotateLiveFlags = { app: false, static: false };
  const subcommand = args.find((arg) => !LIVE_FLAGS.has(arg));
  if (subcommand !== "annotate") return flags;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === "--app") flags.app = true;
    else if (args[i] === "--static") flags.static = true;
    else continue;
    args.splice(i, 1);
  }
  return flags;
}
