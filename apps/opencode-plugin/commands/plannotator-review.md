---
description: Open interactive code review for current changes or a PR URL; pass --git or --gitbutler to force that provider, --base <ref> / --diff-type <type> to pin the session's opening diff (session-only, git-only)
---

Run `plannotator review $ARGUMENTS` with Bash, in the foreground, and wait for it to finish.

Relay its stdout to the user. If it returns feedback or annotations, address them now. If it returns an approval, say the review passed and continue.

Do not ask the user to run the command themselves.
