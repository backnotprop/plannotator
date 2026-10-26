---
name: plannotator-inbox
description: Open the Plannotator Inbox in the browser (starting it if needed) and tell the person its address.
disable-model-invocation: true
---

# Plannotator Inbox

Use this skill when the person wants their Plannotator Inbox: they closed its tab, or ask where it is.

Run:

```bash
plannotator inbox --open
```

Behavior:

1. Run the command. It opens the Inbox in the person's browser, starting it in the background when it is not running, prints the address and returns at once.
2. Tell the person the address in one sentence and stop. Do not begin any work. When it also says no browser opened (a remote session), pass on how it says to reach the Inbox.
3. If it fails, tell them what it says. `Unknown inbox option: --open` means their Plannotator is older than this command: they can update with `plannotator update`, or run `plannotator inbox` in a terminal.

Run the command yourself rather than telling the person to run it.
