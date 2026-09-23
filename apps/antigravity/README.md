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
- Review and annotation skills under `skills/`, with `PLANNOTATOR_ORIGIN=antigravity`
  set explicitly so their UI and feedback use the correct agent identity.
  Antigravity namespaces plugin skills; find them through `/skills` or slash-command
  completion (`/plannotator:plannotator-review` and `/plannotator:plannotator-annotate`).

## Compatibility

Use Antigravity CLI 1.2.7 or newer as the supported baseline. Earlier versions
had fixes for plugin discovery, empty pre-tool decisions (1.0.16), and plugin
skill namespacing. The hook relies on `{}` abstaining for unrelated writes.

The installer probes the downloaded Plannotator binary with an unrelated native
hook payload before copying skills or writing plugin configuration. If that
binary does not support Antigravity, installation of this integration is skipped
with a reason, preserving existing files. This also protects installations pinned
to older Plannotator releases without guessing which future release ships support.
Testing an unreleased adapter requires a binary built from the same checkout.
Hooks use the absolute path of the binary that passed the probe, so a stale
`plannotator` earlier in `PATH` cannot silently select a different runtime.
The slash-command skills still require the installed binary on the agent's `PATH`;
restart the CLI after a Windows installer updates the user `PATH`.

Antigravity-only profiles no longer trigger the Gemini integration merely because
both use `~/.gemini`. When Antigravity is detected, Gemini also needs its own
`gemini` executable or `~/.gemini/settings.json`; profiles with both retain both
integrations and their independent opt-outs.

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
This is a plan-file review integration, not a guarantee that all implementation
tools wait for plan approval. Antigravity's native artifact approval remains
independent and may still prompt after the file write is approved.

Opt out with `--skip-antigravity` (`-SkipAntigravity` in PowerShell),
`PLANNOTATOR_SKIP_ANTIGRAVITY_INSTALL=1`, or
`{"skipInstall":{"antigravity":true}}` in Plannotator's config. Existing
integrations remain untouched when skipped. `--skip-skills` skips skill copying
while still installing the hook. Uninstall also cleans the obsolete plugin and
policy paths written by the earlier integration.

## Live acceptance check

Before release, use a disposable workspace and a Plannotator binary built from
this branch. Confirm the plugin hook appears in `/hooks` and both skills appear
in slash-command completion, then:

1. Create the conventional plan artifact and verify the browser opens before the write.
2. Reject with feedback; verify the write does not run and the agent receives the feedback.
3. Resubmit the complete revised plan; approve it and verify the exact content is written.
4. Try an incremental plan edit; verify it requests full resubmission.
5. Write an unrelated file; verify its normal permissions remain in force.
6. Invoke both plugin skills; verify the Antigravity origin and returned feedback.
7. Cancel the CLI while review is pending; verify no write executes and no review
   process remains. Separately check browser-close behavior and native artifact prompts.

Automated installer tests exercise Bash, PowerShell, and CMD in temporary profiles,
including old binaries and coexisting Gemini configuration. Adapter unit tests and
`agy plugin validate` are not substitutes for this live acceptance check.
The installed CLI's `agy plugin list` lists imported plugins; it is not proof
that a manually installed plugin's hooks are loaded in a running conversation.

References: [native hooks](https://www.agy.dev/docs/hooks/),
[plugin layout](https://www.agy.dev/docs/plugins/),
[artifact review](https://www.agy.dev/docs/cli/artifacts/).
