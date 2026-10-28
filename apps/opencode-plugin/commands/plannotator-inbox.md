---
description: Open the Plannotator Inbox in the browser and show its address
---

Run `plannotator inbox --open` with Bash. It opens the Plannotator Inbox in the browser, starting it in the background when it is not running, prints the address and returns at once.

Tell the user the address in one sentence and stop; when it also says no browser opened (a remote session), pass on how it says to reach the Inbox. Do not begin any work. If it fails, tell the user what it says; `Unknown inbox option: --open` means their Plannotator is older than this command (update with `plannotator update`, or run `plannotator inbox` in a terminal).

Do not ask the user to run the command themselves.
