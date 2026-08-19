# Vim controls UX smoke test

This smoke test evaluates Vim controls as a reviewer experiences them. It is
not a key-by-key implementation checklist: each journey starts from a realistic
user intent and verifies focus, movement, selection, annotation, recovery, and
feedback together.

Run the complete matrix against both renderer paths:

- Markdown in the plan or annotate application.
- Raw HTML through the sandboxed HTML viewer, using
  `tests/test-fixtures/vim-ux-smoke.html`.
- Select and Pinpoint input methods.
- Vim HUD with the Key panel both visible and hidden.

## Launch

Build and run the real plan application:

```bash
bun run build:hook
bun run dev:hook -- --host 127.0.0.1
```

Run the raw-HTML fixture through the real annotate server:

```bash
PLANNOTATOR_REMOTE=1 \
PLANNOTATOR_PORT=3019 \
PLANNOTATOR_AI=disabled \
PLANNOTATOR_SHARE=disabled \
bun apps/hook/server/index.ts annotate tests/test-fixtures/vim-ux-smoke.html
```

Enable **Settings → Vim → Vim controls**. Enable **Vim HUD** when a
scenario asks for visible targeting feedback.

## Journey 1: start reviewing without hunting for focus

**User intent:** open a document and immediately start moving through it.

1. Open a neutral document with Vim controls enabled.
2. Without clicking the document, press `j`, `k`, `gg`, and `G`.
3. Focus an app control, then press `Escape`.
4. Press `j` again.

Expected:

- The document takes focus automatically once it is ready.
- The first target is a real semantic block, never the whole document.
- `j` and `k` move one visible block at a time.
- `gg` and `G` jump to the first and last blocks.
- `Escape` returns from neutral app chrome to the document.
- No document-sized browser focus ring appears.
- An open dialog, composer, picker, or editor keeps first ownership of
  `Escape`; focus returns only after that layer closes.

## Journey 2: scan by document structure

**User intent:** skim a long plan at paragraph granularity, then inspect one
structured area.

1. Move over headings, paragraphs, lists, code blocks, and tables with `j` and
   `k`.
2. Stop on a paragraph containing bold, code, or a link and press `l`.
3. Use `j` and `k` to move across inline siblings; press `h` to return.
4. Stop on a table, press `l` into rows, move between rows, press `l` into
   cells, move between cells, and use `h` to climb back out.

Expected:

- Block movement follows the rendered reading order.
- A code block is one block; its lines and tokens are not separate block
  targets until the user enters text.
- Refinement follows meaningful hierarchy:
  `table → row → cell → text` and `paragraph → inline target → text`.
- `j` and `k` move among siblings at the current level.
- `h` climbs one semantic level without unexpectedly changing position.
- Select and Pinpoint resolve the same visible targets.

## Journey 3: navigate exact text efficiently

**User intent:** reach a variable, value, or sentence fragment without stepping
through every character.

1. Refine into text with `l`.
2. Use `w`, `b`, and `e` across prose and source code.
3. Use `0` and `$` to jump to line boundaries.
4. Use `j` and `k` to move by visual line.
5. Use `{` and `}` to jump between text blocks.
6. Use `h` and `l` for final character adjustments.

Expected:

- Word motions skip whole words/tokens rather than advancing one character.
- Line and paragraph motions make long-distance navigation visibly faster.
- Source-code identifiers, numeric values, punctuation, and prose are all
  reachable.
- The caret sits at the text edge; it does not bisect a highlighted token.
- The viewport scrolls only as needed to keep the active target visible and
  does not jitter between keys.

## Journey 4: select exactly what should be discussed

**User intent:** select a phrase, one code value, or several complete blocks.

1. From text, press `v`, extend with text motions, and select a prose phrase.
2. Repeat for a code identifier and a numeric value such as `3` or `1_500`.
3. Press `o` to swap the fixed and moving ends and refine the other edge.
4. Press `V` on a paragraph or code block.
5. Extend the whole-block selection with `j` and shrink it with `k`.
6. Press `V` again to return to the current semantic block.

Expected:

- Visual selection matches the exact visible characters, including code.
- Highlight geometry begins and ends on the selected glyphs.
- `o` changes which edge moves without changing the selected text.
- Whole-block Visual selects only the intended block range—not unrelated
  bullets, numbers, or neighboring blocks.
- The HUD reticle follows the active range and labels exact text versus whole
  blocks correctly.

## Journey 5: annotate without losing the target

**User intent:** comment, redline, label, or mark up the current target and
continue reviewing.

Run each action from a semantic block and from an exact Visual range:

- `c`: open a comment.
- `d`: create a redline.
- `t`: open quick labels and choose one with its numeric shortcut.
- `m` or `Space`: open the shared annotation toolbar.
- `Enter`: apply the currently selected toolbar mode.

Expected:

- Every action uses the same toolbar, composer, highlighter, annotation model,
  and sidebar entry as pointer selection.
- The composer receives all typed characters—including `j`, `k`, and `gg`;
  document navigation freezes while it owns focus.
- `Command+Enter` saves the comment.
- `Escape` cancels only the open action, restores document focus, and restores
  the exact source range.
- Saving also restores the exact range, even after highlight markup changes
  the DOM.
- Redline applies immediately and returns to a coherent text or block state.
- No comment composer opens merely from rapid navigation over a code block.

## Journey 6: copy and continue

**User intent:** copy an exact phrase or complete block, then keep reviewing.

1. Make a Visual selection and press `y`.
2. Paste into a native text field.
3. Select a complete block with `V`, press `y`, and paste again.

Expected:

- Clipboard text exactly matches the visible selection.
- Visual yank collapses to a text caret; whole-block yank returns to block
  navigation.
- Document focus remains active and the next Vim key works immediately.
- Raw HTML copies through the validated parent bridge without adding
  `allow-same-origin` or clipboard permission to the sandbox.

## Journey 7: learn from the HUD without surrendering space

**User intent:** use the target reticle while choosing how much key guidance is
visible.

1. Enable Vim HUD and navigate through block, inline, text, Visual, and action
   states.
2. Hide the bottom-right Key panel with its close control.
3. Continue navigating.
4. Press `?`, inspect the complete key map, and press `?` again.
5. Disable and re-enable **Settings → Vim → Key panel**.

Expected:

- The four-corner reticle remains visible when the Key panel is hidden.
- Reticle geometry encloses the current semantic block, caret, or exact range.
- The persistent panel reports only handled keys; typed composer text never
  appears in it.
- `?` temporarily opens a complete, contextual command map even when the panel
  is hidden.
- Closing the map returns to reticle-only HUD.
- Key panel preference persists independently from Vim controls and Vim HUD.

## Journey 8: leave Vim safely

**User intent:** interact with normal web controls or turn Vim off without
surprises.

1. Press `Tab` and `Shift+Tab`.
2. Type in a native input or textarea.
3. Activate a native link or button with `Enter`.
4. Disable Vim controls in Settings and type the Vim command keys in the
   document.
5. Re-enable Vim controls and close Settings.

Expected:

- Tab navigation is never consumed by Vim.
- Inputs, textareas, contenteditable regions, dialogs, and embedded editors
  retain native typing.
- Native links and buttons retain native activation.
- With Vim disabled, no unmodified Vim key is consumed and the document does
  not become a focus surface.
- Re-enabling restores automatic document focus while preserving the separate
  HUD and Key panel preferences.

## Journey 9: stress the race-prone path

**User intent:** navigate quickly like an experienced reviewer.

1. Hold or rapidly repeat `j` and `k` across prose, tables, and code.
2. Mix `gg`, `G`, word, line, and block jumps at typing speed.
3. Open and cancel several comments in succession.
4. Save a comment, immediately navigate, then create a different annotation.

Expected:

- Only explicitly invoked actions open UI.
- Navigation keys never leak into a comment composer that was not requested.
- A previous selection cannot reopen a composer after its action completes.
- Focus and reticle state never trail the visible target.
- The page does not oscillate, jump, or blur while following the target.

## 2026-07-26 run record

The complete matrix was run in the real application on macOS/Chromium against
the standalone Markdown plan and the production-built raw-HTML annotate server.

| Area | Markdown | Raw HTML | Evidence |
| --- | --- | --- | --- |
| Automatic focus and Escape recovery | Pass | Pass | Real app |
| Block, document, hierarchy, and sibling movement | Pass | Pass | Real app + DOM integration |
| Word, token, line, and text-block motion | Pass | Pass | Real app |
| Exact Visual and whole-block Visual selection | Pass | Pass | Real app + DOM integration |
| Comment save/cancel and focus restoration | Pass | Pass | Real app + DOM integration |
| Redline, label, active-mode Enter | Pass | Pass | Real app |
| Shared toolbar via `m` / `Space` | Pass | Pass | Full Viewer and bridge integration tests |
| Rapid `j` / `k` over code without phantom composer | Pass | Pass | Real app |
| Yank, paste, and post-yank focus | Pass | Pass | Real app + clipboard bridge tests |
| Select/Pinpoint target parity | Pass | Pass | Real app + integration tests |
| HUD reticle, hidden panel, and temporary `?` map | Pass | Pass | Real app + integration tests |
| Native controls, Tab, and disabled-mode compatibility | Pass | Pass | DOM integration |
| Settings persistence and independent HUD controls | Pass | Pass | Real app + settings tests |

Three real defects were found and fixed during the run:

1. Raw-HTML comment markup replaced the selected text nodes, leaving Visual
   state pointed at a stale range after save. The bridge now restores a range
   over the committed annotation marks.
2. Raw-HTML `y` could not write from the opaque-origin sandbox. It now sends a
   bounded, source-validated copy message to the focused parent viewer, which
   performs the same focus-preserving copy used by Markdown.
3. With Vim auto-focus active, the keyboard block overlay could visually mask
   a nested pointer Pinpoint target. Pointer hover now owns the classic
   Pinpoint overlay until the next handled Vim command, then ownership returns
   immediately to the keyboard target.

The in-app automation driver does not synthesize `m` and `Space` identically
to physical browser input on every macOS layout. Those two commands are covered
through the real `Viewer`/highlighter integration and raw bridge DOM tests,
which assert the shared annotation toolbar opens with the correct range.
