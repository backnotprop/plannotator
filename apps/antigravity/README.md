# Antigravity CLI integration

The installer detects `~/.gemini/config` or the CLI's private data directory,
`~/.gemini/antigravity-cli`. It always installs the plugin into
`~/.gemini/config/plugins/plannotator`. The private directory is a detection
signal only, never an installation destination.

The plugin provides:

- A named `plannotator` hook using Antigravity's `PreToolUse` event and camelCase
  `toolCall` payload. It intercepts `write_to_file` for
  `<artifactDirectoryPath>/implementation_plan.md` and reviews `CodeContent`
  before the write runs. Approval returns `allow`; rejection returns `deny`
  with feedback. Other files and tools receive `{}`, preserving normal permissions.
- The existing review and annotation skills under `skills/`, rather than Gemini
  TOML commands. Antigravity namespaces plugin skills; find them through `/skills`
  or slash-command completion.

## Plan revisions and scope

There is no `exit_plan_mode` tool in Antigravity. This integration gates plan
artifact writes, not a transition out of planning mode. Use `write_to_file` with
`Overwrite: true` and the complete revised plan in `CodeContent`. Incremental
edits using `replace_file_content` or `multi_replace_file_content` are denied
with instructions to resubmit the full content, avoiding an approximation of
Antigravity's patch application rules.

The hook only covers the current conversation's conventional
`implementation_plan.md`. It does not intercept shell commands that write files,
custom plan filenames, or change Antigravity's own artifact-review settings.
Use a CLI version that supports empty pre-tool decisions (verified with 1.2.7).

Opt out with `--skip-antigravity` (`-SkipAntigravity` in PowerShell),
`PLANNOTATOR_SKIP_ANTIGRAVITY_INSTALL=1`, or
`{"skipInstall":{"antigravity":true}}` in Plannotator's config. Existing
integrations remain untouched when skipped. `--skip-skills` skips skill copying
while still installing the hook. Uninstall also cleans the obsolete plugin and
policy paths written by the earlier integration.

References: [native hooks](https://www.agy.dev/docs/hooks/),
[plugin layout](https://www.agy.dev/docs/plugins/),
[artifact review](https://www.agy.dev/docs/cli/artifacts/).
