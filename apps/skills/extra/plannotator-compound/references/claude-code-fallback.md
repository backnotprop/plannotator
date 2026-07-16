# Claude Code Fallback

Read this file only when the user does **not** have a usable Plannotator archive.

This is the secondary path for ordinary Claude Code users whose denial history
exists in `~/.claude/projects/` rather than the Plannotator plans directory (`$PLANNOTATOR_DATA_DIR/plans/` or `~/.plannotator/plans/`).

The goal is the same as the main skill:

- extract the user's real denial reasons
- reduce them into a taxonomy and prompt corrections
- produce the same HTML report design and section flow

## Source of Truth

Use the bundled parser at:

- [scripts/extract_exit_plan_mode_outcomes.py](../scripts/extract_exit_plan_mode_outcomes.py)

Resolve that script path relative to this skill directory before running it.

This script normalizes `ExitPlanMode` outcomes from Claude Code JSONL transcripts
and emits clean JSON parts containing only human-authored denial reasons by default.

Do **not** read raw `~/.claude/projects/**/*.jsonl` directly unless:

- the parser fails
- the user asks for audit-level verification
- you need to inspect one or two suspicious records by hand

The parser exists specifically to strip transcript noise such as generic native
reject strings and wrapper boilerplate.

## Run the Parser

Create the working directory first:

```bash
mkdir -p /tmp/compound-planning
```

Then run the bundled parser. Prefer `python3`; if unavailable, use `python`.

Use a resolved absolute script path, not a repo-local copy.

```bash
python3 [RESOLVED SKILL PATH]/scripts/extract_exit_plan_mode_outcomes.py \
  --projects-dir ~/.claude/projects \
  --json-out /tmp/compound-planning/claude-code-human-reasons.json \
  --show-samples 0
```

Expected output:

- manifest:
  `/tmp/compound-planning/claude-code-human-reasons/claude-code-human-reasons.manifest.json`
- part files:
  `/tmp/compound-planning/claude-code-human-reasons/claude-code-human-reasons.part-XXXX-of-XXXX.json`

The script prints how many records were detected and how many JSON part files were emitted.

## What To Read First

Read the manifest before reading any part file.

The manifest gives you:

- total filtered record count
- total `ExitPlanMode` attempts
- native approval / denial counts
- non-native denial counts
- part file list

Use the part files only after you understand the overall dataset shape.

## Inventory In Fallback Mode

In Claude Code fallback mode, report this dataset instead of the Plannotator file counts:

- human denial reasons found
- total `ExitPlanMode` attempts scanned
- native approvals
- native denials with extractable inline reason
- native denials without recoverable reason
- non-native denials with recoverable payload
- number of emitted JSON parts
- date range from the records
- total days spanned
- distinct sessions
- distinct project roots / `cwd` values

Also calculate:

- average `plan_length_chars` where present
- percentage of all denials that contain a recoverable human reason

Do **not** fabricate Plannotator-only inventory fields in fallback mode:

- no `*-approved.md` counts
- no `*.annotations.md` counts
- no `*.diff.md` counts
- no approved-plan line-count analysis

If the user asks for those specifically, state that Claude Code log fallback mode
does not contain those artifacts.

### Previous Report Detection In Fallback Mode

Previous report detection still applies. Check the user's home directory or
the Plannotator plans directory (`${PLANNOTATOR_DATA_DIR:-~/.plannotator}/plans/`) for existing `compound-planning-report*.html` files. If
found, offer the same incremental vs full choice as Plannotator mode. In
incremental mode, filter the parser output by timestamp rather than by filename
date — use the `timestamp` field in each JSON record.

If no previous report exists, use the first-report naming convention
(`compound-planning-report.html`). Otherwise use the next version number.

## Extraction In Fallback Mode

Treat the emitted JSON part files as the clean source dataset.

### Batching

- **Small datasets (< 200 records):** read the part files directly without extra agents
- **Medium datasets (200-800 records):** split by part file or time range into 2-4 agents
- **Large datasets (800+ records):** split by part file groups or balanced time ranges

All extraction agents should use `model: "haiku"` — they're doing straightforward
file reading and structured extraction, not reasoning.

Each extraction agent should read every record in its assigned part files and write
clean markdown output to:

```text
/tmp/compound-planning/extraction-{batch-name}.md
```

### Extraction Prompt For Claude Code Denial Records

Use this prompt for each fallback extraction batch (adapt the part files and output path):

```text
You are extracting structured data from Claude Code ExitPlanMode denial records.

Files to read: [JSON PART FILES]
Output: Write your complete results to [OUTPUT FILE PATH]

Read EVERY record in the assigned files. Each record already contains a cleaned
human_reason field. Use that as the primary source text.

For EACH record, extract:
- Date
- Session ID
- Project / cwd
- Topic (only if inferable from the reason or plan path; otherwise say "Unknown from logs")
- Human denial reason
- What was specifically asked to change
- Feedback type (let the content determine the category)
- Notable phrases
- Reason source (`native_inline_reason`, `non_native_freeform_payload`, or `structured_quote_extraction`)
- Plan path if present
- Plan length in chars if present

Do NOT skip any records. One entry per record.

Format each entry as:
**[session_id :: tool_use_id]**
- Date: ...
- Project: ...
- Topic: ...
- Human denial reason: ...
- Feedback type: ...
- Specific asks: ...
- Notable phrases: ...
- Reason source: ...
- Plan path: ...
- Plan length chars: ...
---

After processing all records, write the complete results to [OUTPUT FILE PATH].
State the total record count at the end of the file.
```

## Reduction In Fallback Mode

The reduction step stays conceptually the same:

- taxonomy
- top patterns
- recurring phrases
- reviewer values
- recurring agent mistakes
- structural requests
- evolution over time
- corrective prompt instructions

Use `model: "sonnet"` for reduction agents, same as Plannotator mode. The
two-stage reduce (partial reduces for 21+ extraction files) also applies when
there are many part files.

But interpret the dataset correctly:

- this is denial-reason evidence from Claude Code logs
- not every denial has a recoverable human reason
- annotations may be absent entirely
- success traits are often inferred from the inverse of repeated denial feedback

If the evidence for "what works" is weaker than the evidence for "what fails",
say that explicitly.

## HTML Report Adaptation

Use the same template and the same section order as the main skill.

In fallback mode:

- explicitly state in the header/meta that the source is Claude Code `ExitPlanMode`
  denial reasons
- keep the same narrative-first editorial style
- keep the same 7 major sections
- use real denial-reason counts, dates, phrases, and percentages only

### KPI Sidebar Substitutes

The Plannotator version uses a revision-rate KPI that may not exist here.

In fallback mode, prefer this KPI trio:

1. top denial category percentage
2. total human denial reasons recovered
3. number of distinct denial categories

If a better third metric emerges from the data, use it, but do not invent one.

### Footer / Provenance

The footer tagline should mention that the report was derived from Claude Code
denial reasons rather than Plannotator markdown archives.

### Important Limitation To State

If `human_reasons_total < total denials`, mention in the narrative or footer note
that some denials in the transcript did not contain recoverable human-authored
feedback and therefore could not contribute to the pattern analysis.

### Versioned Report Naming

Versioned naming (`v2`, `v3`, etc.) applies to fallback mode too. Save reports
to the Plannotator plans directory (`${PLANNOTATOR_DATA_DIR:-~/.plannotator}/plans/`, create the directory if it doesn't exist) so that
all compound planning reports live in the same location regardless of data source.

## Summary In Fallback Mode

At the end, tell the user:

- how many human denial reasons were analyzed
- how many total `ExitPlanMode` attempts were scanned
- the top 3 denial patterns found
- the estimated percentage of denial reasons the corrective instructions address
- the single most impactful prompt improvement
- where the report was saved (including version number)
- if incremental: note that earlier findings are in the previous report

## Improvement Hook In Fallback Mode

The Phase 6 improvement hook applies to fallback mode too. The corrective prompt
instructions derived from Claude Code denial reasons are just as useful for
injection into future planning sessions. Follow the same flow as the main skill.

## Audit Mode

Only if the user asks for raw denial records or transcript noise:

```bash
python3 [RESOLVED SKILL PATH]/scripts/extract_exit_plan_mode_outcomes.py \
  --projects-dir ~/.claude/projects \
  --records-filter denials \
  --json-out /tmp/compound-planning/claude-code-all-denials.json \
  --show-samples 0
```

Do not use this audit-mode output for the normal report unless the user asks for it.
