import { isInboxId } from "@plannotator/core/inbox-types";

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
