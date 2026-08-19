---
name: plannotator-annotate
disable-model-invocation: true
description: Open Plannotator's annotation UI for a file, folder, or URL, then address the returned annotations.
---

# Plannotator Annotate (Kiro)

Run:

```bash
PLANNOTATOR_ORIGIN=kiro-cli plannotator annotate $ARGUMENTS
```

`$ARGUMENTS` should be a markdown or plain-text config file path (.md, .txt, .yaml, .json, .toml, .ini, .csv, .log, …), folder path, html file path, or URL.

If the command reports that the arguments could not be resolved to a file, URL, or folder, work out which target the user means and re-run the command yourself with that concrete path or URL.
