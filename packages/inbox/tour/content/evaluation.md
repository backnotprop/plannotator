# Guided Reviews in VS Code: an honest look, and four directions

Draft, 2026-10-24. Not approved. Same guide throughout: checkout-service PR #482, "Retry failed webhook deliveries with backoff and a dead-letter table", 5 chapters, 8 files.

Files in this folder: `prototype.html` (switch directions and states with the tabs or `?variant=a&state=2`; `&shot=1` hides the controls, `&notes=0` hides the yellow notes), `a1.png` … `d2.png` (1440×900 @2x, with notes) and `*-clean.png` (without), and two shots of Plannotator's real reader on this guide: `ref-plannotator-reader-1440.png` and `ref-plannotator-reader-1100.png` (the portable viewer, rebuilt from this branch).

## Verdict

The job is reading a change as a story. Plannotator's reader is built for that job: a chapter's prose sits beside its diffs, and the whole guide is one scroll. 0.17.0 split the same story across six VS Code surfaces. Each surface is fine alone, but you lose the story between them. **Recommendation: direction A.** Put the real Plannotator reader in one editor tab. Bring the editor's strengths into it (hover, go to definition, references) through the language-server commands, and open the real file beside it when you want to explore. It is also the cheapest direction, because the reader and its hooks already exist.

## The two experiences, side by side

| | Plannotator reader (web, guides.show) | VS Code 0.17.0 |
|---|---|---|
| Reading flow | A chapter is one card: prose on the left, all its diffs on the right, sticky prose. The next chapter is a scroll. | Prose is in a 340 px side panel. Code is in a diff tab, one file at a time. The next file or chapter replaces the tab. |
| Orientation | The card says "02 / 05" and Reviewed. Reviewed chapters fold to one row. | The tree says "0/5 reviewed" (chapters). The status bar says "0/8 files reviewed" (files). CodeLens says "Chapter 2 of 5". These are three counts in two units. |
| Context switching | None while reading. | Guided Reviews tab, Guide tab, file tab, Answer tab, the tree, the chapter panel, and the Comments panel. |
| Diff density | Unified or split Pierre diffs at full width. At 1100 px the 440 px prose column squeezes split diffs (`ref-…-1100.png`). | The diff is the narrowest pane. In `4-answer.png` the side bar and the Answer tab leave about 740 px. Inline lines are cut mid-token ("Promise<voic", "status: re"). |
| Reviewed state | One tick per chapter, on the card. | Ticks per chapter and per file in the tree, plus "Mark chapter reviewed" in the panel. That button is below the fold in `2-ask-box.png` and `4-answer.png`. |
| Comments / ask | Comments sit on the diff lines. | The ask box is a comment thread under the lines. It pushes the code down, and the first one opens the Comments panel over a third of the window (`2a-first-box-opens-comments-panel.png`). The answer opens a third column. |
| Code intelligence | Web: ripgrep-based hover cards, which are approximate. | The real language server, on the real files (the PR worktree): hover, F12, references, edit. |

### What makes the native split feel worse (from the screenshots)

1. **The prose is far from the code it explains.** The "Why this changed" text is in the side bar. The lines it talks about are 400 px to the right, in another scroll. It is the text you most need while you read the diff.
2. **You see one file at a time.** Chapter 3 has two files. You cannot see them together, so "Next file" swaps the tab and you lose the first file.
3. **The diff gets the least room.** In `4-answer.png`: side bar 375 px, diff about 740 px, answer 780 px. The code is the reason for the review, but it has the smallest pane.
4. **The guide shares the side bar with unrelated things.** The guide tree competes with the repo's local changes and PR list (CHECKOUT-SERVICE, Pull requests · 4) in the same view.
5. **The plumbing shows.** Breadcrumbs read "…globalStorage › backnotprop.plannotator-webview › worktrees › github.com__northwind__checkout-service › pr-482-c807bee › src…". CodeLens is one small gray line, cut short in `6-after-link.png` ("Mark reviewed | Ask… | Next file ›").
6. **The story breaks where it matters most.** The Guide tab (`shot-9-overview.png`) already looks like Plannotator: overview, diagram, chapter cards. But the chapter cards are only links. The reading starts, and the experience leaves the tab.

### What the native approach does well (keep it)

Hover, go to definition and references work on real files. The diff uses the reader's own theme, font and keys. For local changes you can edit in place. ⌘P, back and forward work as always. The dashboard, the generation view with the builder, the status bar item, and the agent's answer pages with diagrams are all good. "Follow a call into the rest of the repo, then pick the guide back up" is true, and it should stay true.

## Four directions (the prototype shows each one)

**A · One Guide tab** (`a1`–`a4`). Plannotator's reader (the guide-viewer chain with `AllFilesCodeView`) fills one editor tab. Its tokens map to the editor theme. On editor widths it uses a 320 px prose column and unified diffs. The side bar becomes an outline that follows the reader, or you close it, because the reader's sticky strip shows the chapters. Hover over any token: the extension calls `vscode.executeHoverProvider` / `executeDefinitionProvider` / `executeReferenceProvider` on the real file and the reader draws the card, with "Changed in Chapter 1 ✓" under it. ⌘-click or F12 on a symbol outside the change opens the real file in a native editor beside the reader. A symbol inside the change scrolls the reader to it, with a Back pill. **Ask:** select lines in the reader's diff and ask there. The answer streams in under the lines. The chapter lists its answers, and "Open as page" opens a long answer as today's Answer tab.
- *Feasible:* yes, with stable APIs. The seams already exist: `onTokenHoverEnter/Leave`, `onCodeNavRequest` (⌘-click) and `commentOnly` in `AllFilesCodeView`, and `intel.ts` already runs the three providers for overview links. The reader already ships as a read-only bundle for guides.show.
- *Limits:* it is our card, not VS Code's hover widget. `command:` links in hover markdown do not run. The removed lines are a virtual base document, so language servers give little there (this is also true today). There is no peek view inside a webview. Keys the reader handles (F12, ⌘-click) are ours; global keys like ⌘P still reach VS Code. Find in the guide needs `enableFindWidget`. For local changes the reader must re-diff when a file is saved, or say "changed since".
- *Cost:* **M.** *Risks:* the hover must feel instant (cache per position, debounce, as the web token hover already does). A guide with many large files needs the viewport manager's lazy mounting in a webview.

**B · Reader + live diff** (`b1`–`b3`). Two groups that stay paired: the reader (prose, summaries, progress) on the left, and VS Code's native diff of the file you are reading on the right. When you scroll the reader, the right side follows in one preview tab. Hover, F12 and editing are native. **Ask:** from a native selection (today's comment box). The answer lands in the reader under its chapter, not in a third tab.
- *Feasible:* yes, with `vscode.diff`, `revealRange`, `onDidChangeTextEditorVisibleRanges` and webview messages.
- *Cost:* **M.** *Risks:* the sync code is fiddly. People drag tabs, close a group or split again, and the pairing breaks. Both panes are half width. You still see one file at a time.

**C · Native chapters** (`c1`–`c3`). A chapter opens as one multi-file diff editor (`vscode.changes`), so all its files are in one native scroll. The chapter's prose is a comment thread at the top. The tree stays, and the chapter panel goes. **Ask:** a comment thread whose answer is a markdown reply. No diagram fits in a comment, so "Open the full answer" links out.
- *Feasible:* mostly. There is no zone or inset API for Marketplace extensions (`editorInsets` is proposed only). So in an editor, rich prose can only be a comment thread, a CodeLens line or a single-line decoration.
- *Cost:* **S–M.** *Risks:* it still does not look like Plannotator. Prose in comment threads fills the Comments panel. Side-by-side diffs still cut long lines (`c1`). The overview diagram stays in its own tab.

**D · Guide notebook** (`d1`–`d2`). The guide is a custom notebook. Chapter prose is in markdown cells, and each file is an output drawn by a Pierre renderer. The Outline view, sticky headers, folding and ⌘F come with notebooks. **Ask** is a cell: type a question and run it, and the answer is the cell's output, saved in reading order.
- *Feasible:* yes (serializer, controller, renderer messaging). Hover in the outputs is the same proxy as in A.
- *Cost:* **L.** *Risks:* it looks and acts like a notebook: "+ Code / + Markdown", a kernel name, and a double-click puts prose into edit mode. Save and dirty state are odd for a review. It is a second reader to maintain.

## Recommendation

Build **A**. Take one piece from B: a "Diff in VS Code" button on each file, which opens the native diff beside the reader. Do not keep the pair open all the time.

Why:
- It gives back what the owner likes: prose beside the code, a chapter in one scroll, and one place for the whole guide.
- It keeps the editor's real value. Hover, definitions and references come from the language server. The real file opens beside the reader when you want to explore or edit.
- It is one reader in three places: the web app, guides.show and VS Code. A fix or feature lands once. The artifact and its look are the same everywhere.
- Most of it exists: the reader, the comment cards, the hover and ⌘-click hooks, the `intel.ts` provider calls, the dashboard, the builder and the answer pages.

Keep from 0.17.0: the dashboard, the generation view, ACP, the worktrees, the status bar item and the stored answers. Change: the guide tree becomes an optional outline, the chapter panel and the per-file tabs go, CodeLens shows only in a native diff opened from the reader, and the ask box moves into the reader (a native editor can still ask). A suggestion only: ship 0.17.0, and land A behind a reader setting (`guide` | `native`) so both can be compared on real PRs.

**First step:** a two-day spike to prove the proxied hover in a webview. Hover `computeBackoff` in the reader and see the real TypeScript hover in under ~150 ms on a warm server. If it feels slow or wrong, B is the fallback.

## Uncertain (check before building)

- `vscode.changes` (the multi-diff editor, used by C) is a stable command in recent VS Code, but I did not check our floor. `engines.vscode` is `^1.85.0` today. I also did not check that comment threads and CodeLens work inside the multi-diff editor.
- Latency of `executeHoverProvider` for many hovers from a webview, on a large TypeScript project. I expect it to be fine with caching, but I did not measure it.
- How well the reader's Shiki theme follows a custom VS Code theme. A webview cannot read the theme's token colors, so `resolveFenceTheme` maps by theme name. Dark Modern maps to Dark+; a custom theme may only be close.
- Breadcrumbs for files in a PR worktree show the storage path in every direction that opens a real file. Fixing that means adding the worktree as a workspace folder (which changes the user's workspace) or accepting it.
- Memory with `retainContextWhenHidden` for a large guide in one webview. The viewport manager mounts lazily, but I did not test it in VS Code.
