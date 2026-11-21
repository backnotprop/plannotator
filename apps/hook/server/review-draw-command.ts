/**
 * The old `plannotator review draw` and `plannotator review drawings`, from the
 * first Show me. Show me makes a Shape now (approval "code-review-launch-build",
 * item 1), so an older agent that still calls them gets a refusal that points at
 * `plannotator shape` (index.ts prints it).
 */

import { isInboxId } from "@plannotator/core/inbox-types";

/**
 * Whether argv (after `plannotator`) is one of the old commands, by its shape:
 * `review draw` then --file, --review, --turn or --help; `review drawings`
 * then one review message id, or --help. Anything else (`review drawings`
 * alone, `review draw`, `review drawings ./dir`) is `plannotator review
 * <DIRECTORY | PR_URL>`, as it always was. Off (Code review off), never:
 * the review parse takes it, as in the release before Show me.
 * `codeReviewOn` is asked last, only for these two words: any other command
 * never reads config.json here (a broken one warns only where it always did).
 */
export function isReviewDrawCommand(argv: readonly string[], codeReviewOn: () => boolean): boolean {
  if (argv[0] !== "review" || (argv[1] !== "draw" && argv[1] !== "drawings")) return false;
  const first = argv[2];
  if (first === undefined) return false;
  const shaped =
    argv[1] === "draw"
      ? first === "--help" || first === "-h" || /^--(?:file|review|turn)(?:=|$)/.test(first)
      : first === "--help" || first === "-h" || isInboxId("msg", first);
  return shaped && codeReviewOn();
}
