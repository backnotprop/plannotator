---
name: plannotator-compound
disable-model-invocation: true
description: >
  Analyze a user's Plannotator plan archive to extract denial patterns, feedback
  taxonomy, evolution over time, and actionable prompt improvements — then produce
  a polished HTML dashboard report. Falls back to Claude Code ExitPlanMode denial
  reasons when Plannotator data is unavailable.
---

# Compound Planning Analysis

You are conducting a comprehensive research analysis of a user's Plannotator plan
archive. The goal: extract patterns from their denied plans, reduce
them into actionable insights, and produce an elegant HTML dashboard report.

This is a multi-phase process. Each phase must complete fully before the next begins.
Research integrity is paramount — every file must be read, no skipping.

## Source Selection

Before starting the analysis, determine which data source is available.

1. **Plannotator mode (first-class)** — Determine the Plannotator data directory:
   use `$PLANNOTATOR_DATA_DIR` if set, otherwise `~/.plannotator`. Check the
   `plans/` subdirectory there. If it exists and contains `*-denied.md` files,
   use this mode. The entire workflow below is written for Plannotator data.

2. **Claude Code fallback mode** — If the Plannotator archive is absent or
   contains no denied plans, check `~/.claude/projects/`. If present, read
   [references/claude-code-fallback.md](references/claude-code-fallback.md)
   before continuing. That reference explains how to use the bundled parser at
   [scripts/extract_exit_plan_mode_outcomes.py](scripts/extract_exit_plan_mode_outcomes.py)
   to extract denial reasons from Claude Code JSONL transcripts. Every phase
   below has a short note explaining what changes in fallback mode — the
   reference file has the details.

3. **Neither available** — Ask the user for their Plannotator plans directory or
   Claude Code projects directory. Do not guess.

## Phase 0: Locate Plans & Check for Previous Reports

Use the mode chosen in Source Selection above.

**Plannotator mode:** Verify the plans directory contains `*-denied.md` files. If
none exist, fall back to Claude Code mode before stopping.

**Claude Code fallback mode:** Run the bundled parser per the fallback reference to
build the denial-reason dataset. Create `/tmp/compound-planning/` if needed.

In either mode, proceed to Previous Report Detection below.

### Previous Report Detection

After locating the plans directory, check for existing reports:

```
ls ${PLANNOTATOR_DATA_DIR:-~/.plannotator}/plans/compound-planning-report*.html
```

Reports follow a versioned naming scheme:
- First report: `compound-planning-report.html`
- Subsequent reports: `compound-planning-report-v2.html`, `compound-planning-report-v3.html`, etc.

If one or more reports exist, determine the **latest** one (highest version number).
Get its filesystem modification date using `stat` (macOS: `stat -f %Sm -t %Y-%m-%d`,
Linux: `stat -c %y | cut -d' ' -f1`). This is the **cutoff date**.

Present the user with a choice:

> "I found a previous report (`compound-planning-report-v{N}.html`) last updated
> on {CUTOFF_DATE}. I can either:
>
> 1. **Incremental** — Only analyze files dated after {CUTOFF_DATE}, saving tokens
>    and building on previous findings
> 2. **Full** — Re-analyze the entire archive from scratch
>
> Which would you prefer?"

Wait for the user's response before proceeding.

**If incremental:** Filter all subsequent phases to only process files with dates
after the cutoff date. The new report version will note in its header narrative that
it covers the period from {CUTOFF_DATE} to present, and reference the previous
report for earlier findings. The inventory (Phase 1) should still count ALL files
for overall stats, but clearly separate "new since last report" counts.

**If full:** Proceed normally with all files, but still use the next version number
for the output filename.

**If no previous report exists:** Proceed normally. The output filename will be
`compound-planning-report.html` (no version suffix for the first report).

## Phase 1: Inventory

Count and report the dataset. **Always count ALL files** for overall stats,
regardless of whether this is an incremental or full run:

```
- *-approved.md files (count)
- *-denied.md files (count)
- Date range (earliest to latest date found in filenames)
- Total days spanned
- Revision rate: denied / (approved + denied) — this is the "X% of plans
  revised before coding" stat used in dashboard section 1
```

**Note:** Ignore `*.annotations.md` files entirely. Denied files already contain
the full plan text plus all reviewer feedback appended after a `---` separator.
Annotation files are redundant subsets of this content — reading both would
double-count feedback.

**If incremental mode:** After the total counts, separately report the counts for
files dated after the cutoff date only:

```
New since {CUTOFF_DATE}:
- *-denied.md files: X (of Y total)
- New date range: {CUTOFF_DATE} to {LATEST_DATE}
- New days spanned: N
```

If fewer than 3 new denied files exist since the cutoff, warn the user:
> "Only {N} new denied plans since the last report. The incremental analysis may
> be thin. Would you like to proceed or switch to a full analysis?"

Also run `wc -l` across all `*-approved.md` files to get average lines per
approved plan. This tells the user whether their plans are staying lightweight
or bloating over time. You do not need to read approved plan contents — just
their line counts. If possible, break this down by time period (e.g., monthly)
to show whether plan size changed.

Dates appear in filenames in YYYY-MM-DD format, sometimes as a prefix
(2026-01-07-name-approved.md) and sometimes embedded (name-2026-03-15-approved.md).
Extract dates from all filenames.

Tell the user what you found and that you're beginning the extraction.

**Claude Code fallback mode:** The Plannotator inventory fields above do not apply.
Follow the inventory instructions in
[references/claude-code-fallback.md](references/claude-code-fallback.md) instead —
report the denial-reason dataset assembled by the parser.

## Phase 2: Map — Parallel Extraction

This is the most time-intensive phase. You must read EVERY `*-denied.md` file
**in scope**. Do not skip files. Do not summarize early.

**In scope** means: all denied files if running a full analysis, or only denied
files dated after the cutoff date if running incrementally. In incremental mode,
only process files whose embedded YYYY-MM-DD date is strictly after the cutoff.

**Claude Code fallback mode:** The parser output is the clean source dataset. Read
the fallback reference for the extraction prompt and batching strategy specific to
JSON part files. Do not go back to raw `.jsonl` logs unless the parser fails or the
user asks for audit-level verification.

**Important:** Only read `*-denied.md` files. Do NOT read approved plans,
annotation files, or diff files. Each denied file contains the full plan text
followed by a `---` separator and the reviewer's feedback — everything needed
for analysis is in one file.

### Batching Strategy

All extraction agents should use `model: "haiku"` — they're doing straightforward
file reading and structured extraction, not reasoning. Haiku is faster and cheaper
for this work.

The approach depends on dataset size:

**Tiny datasets (≤ 10 total files):** Read all files directly in the main agent —
no need for sub-agents. Just read them sequentially and proceed to Phase 3.

**Small datasets (11-30 files):** Launch 2-3 parallel Haiku agents, splitting
files roughly evenly.

**Medium datasets (31-80 files):** Launch 4-6 parallel Haiku agents (~10-15 files
each). Split by file type and/or time period.

**Large datasets (80+ files):** Launch as many parallel Haiku agents as needed to
keep each batch around 10-15 files. Split by the natural time boundaries in the
data (months, quarters, or whatever groupings produce balanced batches). If one
time period dominates (e.g., the most recent month has 3x the files), split that
period into multiple batches.

Launch all extraction agents in parallel using the Agent tool with
`run_in_background: true` and `model: "haiku"`.

### Output Files

Each extraction agent must write its results to a clean output file rather than
relying on the agent task output (which contains interleaved JSONL framework
logs that are difficult to parse). Instruct each agent to write to:

```
/tmp/compound-planning/extraction-{batch-name}.md
```

Create the `/tmp/compound-planning/` directory before launching agents. The
reduce agent in Phase 3 will read these clean files directly.

### Extraction Prompt

Each agent receives this instruction (adapt the time period, file list, and
output path):

```
You are extracting structured data from denied plan files for a pattern analysis.

Directory: [PLANS DIRECTORY]
Files to read: [LIST OF SPECIFIC *-denied.md FILES]
Output: Write your complete results to [OUTPUT FILE PATH]

Each denied file contains two parts separated by a --- line:
1. The plan text (above the ---)
2. The reviewer's feedback and annotations (below the ---)

Read EVERY file in your list. For EACH file, extract:
- The plan name/topic (from the plan text above the ---)
- The denial reason or feedback given (from below the --- — capture the actual
  words used)
- What was specifically asked to change
- The type of feedback (let the content determine the category — don't force-fit
  into predefined types. Common types include things like: scope concerns,
  approach disagreements, missing information, process requirements, quality
  concerns, UX/design issues, naming disputes, clarification requests,
  testing/procedural denials — but the user's actual patterns may differ)
- Any specific phrases or recurring language from the reviewer
- Individual annotations if present (numbered feedback items with quoted text
  and reviewer comments)
- The date (extracted from the filename)

Do NOT skip any files. One entry per file.

Format each entry as:
**[filename]**
- Date: ...
- Topic: ...
- Denial reason: ...
- Feedback type: ...
- Specific asks: ...
- Notable phrases: ...
- Annotations: [count, with brief summary of each]
---

After processing all files, write the complete results to [OUTPUT FILE PATH].
State the total file count at the end of the file.
```

### While Agents Run

Track completion. As each agent finishes, note the count of files it processed.
Verify the total matches the inventory from Phase 1. If any agent's count is
short, flag it and consider re-launching for the missing files.

If an agent times out (possible with large batches — a batch of 128 files can
take 8+ minutes), re-launch it for just the unprocessed files. Check the output
file to see how far it got before timing out.

## Phase 3: Reduce — Pattern Analysis

Once ALL extraction agents have completed (or all files have been read for tiny
datasets), proceed with the reduction. Reduction agents should use `model: "sonnet"`
— this phase requires real analytical reasoning, not just file reading.

### Reduction Strategy

The approach depends on how many extraction files were produced:

**Standard (≤ 20 extraction files):** Launch a single Sonnet agent to read all
extraction files and produce the full analysis. This covers most datasets.

**Large (21+ extraction files):** Use a two-stage reduce:

1. **Stage 1 — Partial reduces:** Split the extraction files into groups of 4-6.
   Launch parallel Sonnet agents, each reading one group and producing a partial
   analysis with the same sections listed below. Each writes to
   `/tmp/compound-planning/partial-reduce-{N}.md`.

2. **Stage 2 — Final reduce:** A single Sonnet agent reads all partial reduce
   files and synthesizes them into the final comprehensive analysis. This agent
   merges taxonomies, combines counts, deduplicates patterns, and reconciles any
   conflicting categorizations across partials.

**Claude Code fallback mode:** The reduction phase is the same. The only upstream
difference is that extraction files were derived from normalized denial-reason JSON
instead of Plannotator markdown files.

### Reduction Prompt

Give each reduction agent this prompt (adapt file paths for single vs multi-stage):

```
You are a data scientist conducting the reduction phase of a map-reduce analysis
across a user's denied plan archive.

Read ALL extraction files at [FILE PATHS]

These files contain structured extractions from every denied plan file. Each
extraction includes the plan topic, denial feedback, annotations, and reviewer
language. Your job: aggregate everything, find patterns, cluster into a taxonomy,
and produce a comprehensive analysis.

Be exhaustive. Use real counts. Quote real phrases from the data. This is
research — no hand-waving, no fabrication.

Write your complete results to [OUTPUT FILE PATH].

Produce the following sections:
[... sections listed below ...]
```

The reduction agent's job is to let the data speak. Do not impose a predetermined
framework — discover what's actually there. The analysis must produce:

### 1. Denial Reason Taxonomy
Categorize every denial into a finite set of types that emerge from the data. Count
occurrences. Show percentages. Include real example quotes for each type. Aim for
8-15 categories — enough to be specific, few enough to be scannable. Let the user's
actual feedback determine what the categories are.

### 2. Top Feedback Patterns (ranked by frequency)
The 5-10 most recurring patterns. For each: what the reviewer consistently asks for,
3+ example quotes from different files, and whether the pattern changed over time.

### 3. Recurring Phrases
Exact phrases the reviewer uses repeatedly, with counts and what they signal. These
are the reviewer's vocabulary — their shorthand for what they care about.

### 4. What the Reviewer Values (implicit preferences)
Derived from patterns — what does this specific person care about most? Quality?
Speed? Narrative? Architecture? Process? Simplicity? Rank by evidence strength.
This section should feel like a personality profile of the reviewer's standards.

### 5. What Agents Consistently Get Wrong
The flip side — what recurring mistakes trigger denials? What should agents stop
doing for this reviewer?

### 6. Structural Requests
What plan structure does the reviewer consistently demand? Required sections,
ordering, format preferences, level of detail expected.

### 7. Evolution Over Time
How feedback patterns changed across the time span. Group by whatever natural time
boundaries exist in the data (weeks for short spans, months for longer ones). Did
expectations mature? Did new patterns emerge? What shifted? If the dataset spans
less than a month, note that evolution analysis is limited but still look for any
progression from early to late files.

### 8. Actionable Prompt Instructions
The most important output. Based on all patterns: specific numbered instructions
that could be embedded in a planning prompt to prevent the most common denial
reasons. Write these as actual directives an agent could follow. Be specific to
this user's patterns — generic advice like "write good plans" is worthless. Each
instruction should trace back to a real, frequent denial pattern.

After writing the instructions, calculate what percentage of denials they would
address (count how many denials fall into categories covered by the instructions
vs total denials). Report this percentage — it will be different for every user.

## Phase 4: Generate the HTML Dashboard

Build a single, self-contained HTML file as the final deliverable. Save it to
the user's plans directory with a versioned filename:

- First ever report: `compound-planning-report.html`
- Second report: `compound-planning-report-v2.html`
- Third report: `compound-planning-report-v3.html`
- And so on.

The version number was determined in Phase 0 based on existing reports found.

**If this is an incremental report**, the header should indicate the analysis
period (e.g., "March 15 – March 31, 2026") and include a subtitle noting
"Incremental analysis — see v{N-1} for earlier findings." The narrative in
section 1 should frame findings as what's new or changed since the last report,
not as a complete picture. Overall stats in the header (file counts, revision
rate) should still reflect the full archive for context.

Read the template at `assets/report-template.html` for the **design language
only**. The template contains example data from a previous analysis — ignore all
data values, quotes, and percentages in the template. Use only its visual design:
colors, typography, spacing, component styles, and layout patterns.

### Design Language (from template)

- **Palette:** Light mode, warm off-white (#FDFCFB), text in slate scale, amber
  for highlights/accents, emerald for positive, rose for negative, indigo for
  action elements
- **Typography:** Playfair Display (serif, for narrative headings), Inter (sans,
  for body/data), JetBrains Mono (mono, for code/phrases) — Google Fonts CDN
- **Layout:** Single-column, max-width 1024px, generous vertical whitespace (128px
  between major sections), editorial/narrative-first aesthetic
- **Tone:** Calm, reflective, authoritative. Like a personal retrospective journal,
  not a monitoring dashboard.

### Page Frame (header + footer)

Before the 7 sections, the page has:

- **Header:** Report title on the left (Playfair Display, ~36px), project name +
  date range below it in light meta text. On the right: file counts in mono
  (e.g., "223 denials · 71 days"). Separated from content by
  a bottom border. Generous bottom padding before section 1.

- **Footer:** After section 7. Top border, centered italic Playfair Display tagline
  summarizing the corpus (e.g., "Analysis of X denied plans from the Plannotator
  archive.").

### Dashboard Section Order (7 sections)

The report follows this exact section order. Each section builds on the previous
one — the flow moves from "what happened" through "why" to "what to do about it":

1. **The story in the data** — An editorial narrative paragraph (Playfair Display
   serif, ~26px) that tells the headline finding in prose. Not bullet points — a
   real paragraph that reads like the opening of an article. Alongside it, a KPI
   sidebar with 3 key metrics (the top denial percentage, the overall revision
   rate, and the number of distinct denial categories found). Use an amber inline
   highlight on the most striking number in the narrative.

2. **Why plans get denied** — The taxonomy as a ranked list. Each row: rank number
   (mono), category label, a thin 4px progress bar (top item in amber-500, rest
   in slate-300), percentage (mono), and for the top entries, a real italic quote
   from the data below the label. Show the top 10 categories or however many the
   data supports (minimum 5).

3. **How expectations evolved** — One card per natural time period. Each card has:
   the period name in serif, a theme phrase in colored uppercase (different color
   per period to show progression), a description paragraph, and a stat line at
   the bottom (e.g., "X denials · Y narrative requests"). If the data spans less
   than 3 distinct periods, use 2 cards or even a single card with internal
   progression noted.

4. **What works vs what doesn't** — Two side-by-side cards. Left: green-tinted
   (emerald-50/50 bg, emerald-100 border) with traits of plans that succeed for
   this reviewer. Right: red-tinted (rose-50/50 bg, rose-100 border) with what
   agents keep getting wrong. Both derived from the reduction analysis. Bulleted
   with small colored dots. 5-8 items per card.

5. **The actionable output** — The diagnostic payoff. Opens with a Playfair
   Display narrative sentence stating how many prompt instructions were derived
   and what estimated percentage of denials they address (use the real calculated
   percentage from Phase 3, not a generic number). Then the top 3 most impactful
   improvements as numbered items, each with an amber number, bold title, and
   one-line description. This section bridges the analysis and the full prompt
   that follows.

6. **Your most-used phrases** — Grid of chips (2-col mobile, 3-col desktop). Each
   chip: monospace quoted phrase on the left, frequency count on the right. White
   bg, slate-200 border, rounded-12px. Show 9-12 of the most recurring phrases
   found. These should be the reviewer's actual words — their verbal fingerprint.

7. **The corrective prompt** — Dark panel (slate-900 bg, white text, rounded-3xl,
   shadow-xl). Opens with a Playfair intro sentence about the instructions. Then
   a dark code block (slate-800/80 bg, amber-200 monospace text) containing the
   full numbered prompt instructions from Phase 3. Include a copy-to-clipboard
   button that works (JS included). Below the code block: a gradient glow card
   (indigo-to-purple blurred halo behind a white card) with a closing message
   that these instructions are personal — derived from the user's own feedback,
   their own language, their own standards.

### Adaptation Rules

- If the user has < 3 months of data, reduce the evolution section to fewer cards
- If most denied files lack feedback below the `---` (bare denials with no
  annotations), note this in the narrative — the analysis will be thinner
- **Claude Code fallback mode:** Explicitly label the report source as Claude Code
  `ExitPlanMode` denial reasons. Do not fabricate Plannotator-only fields such as
  annotation counts or approved-plan line counts. See the fallback reference for
  KPI substitutes and footer/provenance guidance.
- If fewer than 5 denial categories emerge, combine the taxonomy and patterns
  sections into one
- If the dataset is very small (< 20 files), the narrative should acknowledge the
  limited sample size and frame findings as preliminary
- The number of prompt instructions will vary per user — could be 8 or 20. Don't
  force exactly 17. Let the data determine the count.
- The top 3 actionable items in section 5 must be the 3 that cover the largest
  share of denials, not the 3 that sound most impressive

### Key Rules

1. Every number must come from the real analysis — no fabricated data
2. Every quote must be a real quote from a real file
3. The taxonomy percentages must be calculated from real counts
4. The prompt instructions must trace back to actual denial patterns
5. The copy button on the prompt block must work (include the JS)

After generating, open the file in the user's browser.

## Phase 5: Summary

Tell the user:
- How many denied files were analyzed
- If incremental: how many were new since the last report
- The top 3 denial patterns found
- The estimated percentage of denials the prompt instructions would address
- The single most impactful prompt improvement
- Where the report was saved (including version number)
- If incremental: remind the user that earlier findings are in the previous report

**Claude Code fallback mode:** Adapt the summary per the fallback reference —
report human denial reasons analyzed and total `ExitPlanMode` attempts scanned
instead of Plannotator file counts.

## Phase 6: Improvement Hook

After presenting the summary, ask the user if they want to enable an **improvement
hook** — this takes the corrective prompt instructions from section 7 of the report
and writes them to a file that Plannotator's `EnterPlanMode` hook can inject into
every future planning session automatically.

> "Would you like to enable the improvement hook? This will save the corrective
> prompt instructions to a file that gets automatically injected into all future
> planning sessions — so Claude sees your feedback patterns before writing any plan."

**If yes:**

The hook file lives at:

```
${PLANNOTATOR_DATA_DIR:-~/.plannotator}/hooks/compound/enterplanmode-improve-hook.txt
```

Create the `hooks/compound/` directory inside the data directory if it doesn't exist.

The file contents should be the corrective prompt instructions from Phase 3 —
the same numbered list that appears in section 7 of the HTML report. Write them
as plain text, one instruction per line, prefixed with their number. No HTML, no
markdown fences, no preamble — just the instructions themselves. The hook system
will inject this file's contents as-is into the planning context.

**If the file already exists:**

Read the existing file and present the user with a choice:

> "An improvement hook already exists from a previous analysis. I can:
>
> 1. **Replace** — Overwrite with the new instructions (the old ones are gone)
> 2. **Merge** — Combine both, deduplicating overlapping instructions and
>    keeping the best version of each
> 3. **Keep existing** — Leave the current hook as-is, skip this step
>
> Which would you prefer?"

- **Replace:** Overwrite the file with the new instructions.
- **Merge:** Read the existing instructions, compare with the new ones, and
  produce a merged set. Remove duplicates (same intent even if worded differently).
  When two instructions cover the same pattern, keep the more specific or
  actionable version. Re-number the final list sequentially. Write the merged
  result to the file. Show the user what changed (added N new, removed N
  redundant, kept N existing).
- **Keep existing:** Do nothing, move on.

**If no:** Skip this phase entirely.

## Important Notes

- **Data source priority:** Plannotator is the first-class path. Claude Code log
  analysis is the secondary path for users without Plannotator archives.
- **Research integrity:** Every file must be read. The value of this analysis comes
  from completeness. Sampling or skipping undermines the findings.
- **Real data only:** Never fabricate quotes, percentages, or patterns. If the data
  doesn't show a clear pattern, say so honestly rather than inventing one.
- **Let the data lead:** The taxonomy, patterns, and instructions should emerge from
  what's actually in the files. Different users will have completely different
  denial patterns. A user building mobile apps will have different feedback than
  one building APIs. Don't assume what the patterns will be.
- **Agent parallelization:** For large datasets, maximize parallel agents to reduce
  wall-clock time. The bottleneck is the largest batch — split it.
- **Structured extraction format:** Ask extraction agents to return structured text
  with consistent delimiters so the reduce agent can parse reliably.
- **The report is the artifact:** The HTML dashboard is what the user keeps. It
  should be beautiful, honest, and useful. Every section should feel like it was
  written about them specifically, because it was.
