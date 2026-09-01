# Working on `@plannotator/ui`

This is the **published, reusable document UI** (`@plannotator/ui` + `@plannotator/core`). The commercial Workspaces app installs it and plugs in its own backend; Plannotator uses the defaults. See **`README.md`** in this directory for the architecture (packages, seams, `configurePlannotatorUI`, publishing).

**The rules when editing here:**

- **Do not reimplement the document UI from scratch.** A prior from-scratch rewrite broke the app and was reverted.
- To support a host's different backend, **add an optional seam** (a module-level `setX`/`resetX` default, or an optional prop) whose default reproduces today's behavior. Plannotator passes nothing and stays **byte-for-byte unchanged**.
- `@plannotator/core` is browser-safe and zero-dep — **no `node:` imports** (CI enforces it). `@plannotator/shared`/`@plannotator/ai` stay private; `shared` re-exports `core` via shims.
- **Never delete working Plannotator code until a human confirms parity in the browser.**
- **Text the renderer draws but the document does not contain must be flagged**, or annotation anchoring silently breaks. Annotation restore matches a markdown quote against the page by rendering the quote with this same renderer (`utils/renderedText`) and walking both sides with `VISIBLE_TEXT`, which skips `[aria-hidden="true"]` and `[data-decorative]`. So a new bullet, numeral, badge, or counter needs one of those two attributes — `aria-hidden` when nothing should hear it, `data-decorative` when it must stay audible (a list glyph, since these list items are divs and carry no list semantics). Never widen the walker to `textContent`.
