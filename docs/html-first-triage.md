# HTML-First Annotation Triage

Context: PR #924 changes local `.html` / `.htm` annotation from "convert to markdown by default" to "render raw HTML by default", with `--markdown` as the opt-in conversion path.

This document triages the review findings, records the chosen semantics, and scopes the work needed to make HTML-first solid.

Status after the follow-up implementation:

- Remote raw HTML annotation sessions emit encrypted paste-service share links.
- Local raw HTML annotation rewrites same-directory support assets through a scoped `/api/html-assets/...` route.
- Bun and Pi both serve rewritten raw HTML for initial annotation files and linked/folder HTML files.
- Root-relative assets and packaged remote asset sharing remain deferred.

## Current State

Implemented in PR #924:

- Single local HTML files render through `HtmlViewer` by default.
- `--markdown` converts local HTML through Turndown.
- `--render-html` is still accepted as a legacy compatibility flag.
- Folder and linked HTML now default to raw HTML in Bun and Pi, with `convert=1` used when the session was started with `--markdown`.
- Initial raw HTML sessions keep the left TOC sidebar closed.

Known limitation before the follow-up implementation:

- Raw HTML is rendered with `iframe.srcDoc`.
- `srcDoc` does not naturally know the source file's directory.
- Relative browser assets like `./style.css`, `./app.js`, `./logo.png`, and CSS `url(...)` references can resolve incorrectly unless Plannotator explicitly serves or rewrites them.

## Finding 1: Remote Share Regression

Review finding:

> Default raw HTML mode drops the only remote-access path for HTML annotations.

Verdict: real blocker.

### Verified Behavior

In `apps/hook/server/index.ts`, local HTML now does this by default:

```ts
rawHtml = html;
markdown = "";
```

Later, remote share only emits a link when `markdown` is truthy:

```ts
if (isRemote && sharingEnabled && markdown) {
  await writeRemoteShareLink(markdown, shareBaseUrl, "annotate", "document only");
}
```

So SSH/devcontainer users annotating `page.html` no longer get a share link. Before PR #924, the HTML was converted to markdown, `markdown` was non-empty, and the remote share path still worked.

### Does Fixing This Enable HTML Sharing?

Yes, but with an important boundary.

It enables sharing the raw HTML document itself:

- Works well for self-contained HTML.
- Works for external assets such as CDN styles/scripts/images.
- Works for inline CSS, inline SVG, data URLs, and single-file visual explainers.

It does not automatically make local support files shareable:

- `./style.css`
- `./app.js`
- `./images/logo.png`
- CSS `url("./bg.png")`

Those files live on the local filesystem. A remote share payload containing only `{ h: rawHtml, r: "html" }` cannot make them available to another browser.

### Recommended Fix

Add server-side raw HTML remote sharing using the existing encrypted paste-service format.

Current browser-side short sharing already supports this payload:

```ts
{
  p: "",
  a: [],
  h: rawHtml,
  r: "html"
}
```

The server-side remote share helper should gain the same capability.

Suggested shape:

- Move or duplicate the paste-share creation logic into `packages/server/share-url.ts`, without importing UI types.
- For markdown, keep current hash-link behavior.
- For raw HTML, create an encrypted paste payload and emit a `/p/<id>#key=<key>` URL.
- Thread `pasteApiUrl` into the remote share helper from the annotate command path.
- If paste service is unavailable, either:
  - print a clear warning that raw HTML remote sharing needs the paste service, or
  - fall back to `--markdown` conversion only when explicitly requested by design.

Recommended behavior: do not silently convert raw HTML back to markdown. That would violate the new default.

### Effort

Small to medium.

Expected implementation time: 2-4 hours.

Files likely touched:

- `packages/server/share-url.ts`
- `apps/hook/server/index.ts`
- tests for server share URL generation

Validation:

- Unit test raw HTML remote share creates paste-style URL.
- Unit test markdown remote share still creates hash URL.
- Manual or mocked test for `plannotator annotate page.html` in forced remote mode.

## Finding 2: Relative HTML Assets Break

Review finding:

> Raw-by-default HTML rendering breaks files that depend on relative assets.

Verdict: real blocker if HTML-first is meant to handle ordinary local HTML files, not only self-contained generated HTML.

### Verified Behavior

`HtmlViewer` renders with:

```tsx
<iframe srcDoc={srcdoc} />
```

No `<base>` tag is injected and no relative asset URLs are rewritten.

That means relative browser references are resolved relative to the Plannotator app document, not the original HTML file on disk.

Examples that can fail:

```html
<link rel="stylesheet" href="./style.css">
<script src="./app.js"></script>
<img src="./logo.png">
<video src="./demo.mp4" poster="./poster.jpg"></video>
```

Existing endpoints are not enough:

- `/api/image` is image-oriented and validates image extensions.
- `/api/doc` returns JSON, not raw asset bytes.
- Pi mirrors the image-only shape.

### Should We Use parse5?

Yes.

Totpage uses `parse5` for the right reason: HTML asset references are structured, not reliable string patterns. The useful pattern from `/Users/ramos/oss/totpage` is:

- Parse HTML with `parse5`.
- Walk the tree.
- Detect direct browser support refs.
- Skip external URLs, `data:`, anchors, and ordinary navigation links.
- Treat local support files separately from the raw HTML body.

For Plannotator, we should adapt that to local serving instead of uploading.

### Recommended Fix

Add a scoped local asset-serving path for raw HTML annotation.

Core idea:

- Keep raw HTML as the annotation document.
- Rewrite direct local support refs to a Plannotator asset route.
- Serve those files from the HTML file's directory, with traversal protection.

Proposed route:

```text
GET /api/html-assets/<base-token>/<relative/path/to/asset>
```

Where:

- `<base-token>` is a base64url encoding of the source HTML directory, or a session-local opaque token mapped to that directory.
- `<relative/path/to/asset>` is normalized and must stay inside the permitted base.
- The route serves raw bytes with a content type based on extension.

Path-style routing is preferable to query params because CSS relative URLs then work naturally:

```html
<link rel="stylesheet" href="/api/html-assets/<base>/style.css">
```

If `style.css` contains:

```css
body { background: url("./bg.png"); }
```

The browser resolves it to:

```text
/api/html-assets/<base>/bg.png
```

### Asset References To Handle First

First pass should handle direct browser support refs:

- `img[src]`
- `source[src]`
- `source[srcset]`
- `img[srcset]`
- `video[src]`
- `video[poster]`
- `audio[src]`
- `link[href]` for stylesheets, icons, preload, modulepreload
- `script[src]`

Leave these alone:

- `http:`, `https:`, and protocol-relative URLs
- `data:`, `blob:`
- `mailto:`, `tel:`
- `#anchor`
- ordinary document navigation links like `<a href="other.html">`

Open question:

- Whether to support root-relative URLs like `/assets/app.css`.

Recommendation for first pass: do not support root-relative local refs unless we define the root clearly. Relative-to-file is predictable; root-relative could mean project root, filesystem root, or a built-site root.

### Why Not Just Inject `<base>`?

Injecting a `<base>` tag is tempting but too blunt.

It changes all relative URLs, including ordinary navigation links:

```html
<a href="other.html">
```

That could navigate the iframe to a raw asset route and bypass Plannotator's injected bridge script. It also does not give us good control over what is served.

A targeted parse-and-rewrite pass is safer.

### Bun And Pi Parity

This needs both server implementations:

- Bun server:
  - `packages/server/annotate.ts`
  - `packages/server/reference-handlers.ts`
  - likely a shared route helper in `packages/server`

- Pi server:
  - `apps/pi-extension/server/serverAnnotate.ts`
  - `apps/pi-extension/server/reference.ts`
  - likely a mirrored local helper or vendored shared logic

Shared runtime-agnostic logic should live in `packages/shared`:

- HTML parsing and ref rewriting
- content type map
- path normalization policy

Server-runtime logic should stay in each runtime:

- reading bytes
- returning HTTP response objects
- route registration

### Dependency

Likely add `parse5`.

Because Pi publishes as a separate package, `parse5` needs to be available to Pi too if the shared parser code is vendored or imported there.

Expected dependency updates:

- root/package or workspace dependency as appropriate
- `apps/pi-extension/package.json` if Pi runtime imports parse5 directly or through vendored code
- lockfile

### Effort

Medium.

Expected implementation time: 1-2 days.

The hard parts are not the route itself. The hard parts are:

- getting Bun/Pi parity correct
- not opening path traversal holes
- preserving CSS-relative URL behavior
- avoiding unexpected rewrites of navigation links
- testing `srcset` and CSS asset resolution

Validation:

- Unit tests for parse5 rewrite:
  - rewrites local support refs
  - leaves external/data/blob/anchor refs alone
  - handles `srcset`
  - handles stylesheet and CSS-relative assets via path-style route
  - rejects traversal

- Bun route tests:
  - serves CSS, JS, image, SVG, font/video if allowed
  - rejects traversal outside base
  - returns correct content type

- Pi route tests:
  - same contract as Bun

- Browser smoke test:
  - annotate an HTML file with `style.css` and image next to it
  - verify styles and image render in the iframe

## Finding 3: AGENTS.md / CLAUDE.md Docs

Review finding:

> CLAUDE.md still describes HTML as converted to markdown unless `--render-html`.

Verdict: valid cleanup.

`CLAUDE.md` is a symlink to `AGENTS.md`, so update `AGENTS.md`.

Needed changes:

- Annotate Flow:
  - old: `.html/.htm -> converted to markdown via Turndown (or rendered as-is with --render-html)`
  - new: `.html/.htm -> rendered as raw HTML by default (use --markdown to convert via Turndown)`

- Any API/data comments that say `--render-html mode` should become "raw HTML rendering mode" or "direct HTML rendering mode".

Effort: 15-30 minutes.

## Finding 4: Parsed `renderHtml` Field

Review finding:

> `ParsedAnnotateArgs.renderHtml` is now effectively orphaned and confusing.

Verdict: partially valid, but not a blocker.

The field still has one useful role:

- `apps/opencode-plugin/cli-bridge.ts` forwards legacy `--render-html` to the child CLI.

Direct runtimes intentionally ignore the flag because raw HTML is now the default.

Options:

1. Leave as-is.
   - Lowest risk.
   - Keeps compatibility.
   - Slight semantic confusion remains.

2. Rename to `legacyRenderHtml`.
   - Clearer.
   - Keeps pass-through compatibility.
   - Requires updating tests and bridge code.

3. Remove it.
   - Not recommended.
   - Breaks pass-through compatibility from OpenCode CLI bridge.

Recommendation: rename to `legacyRenderHtml` if we are already touching the parser again. Otherwise leave it.

Effort: 30-60 minutes.

## Scope Before Merge

Implemented follow-up scope:

1. Fix remote raw HTML sharing.
2. Implement local asset serving and parse5-based URL rewriting for raw HTML.
3. Update `AGENTS.md` and stale comments.
4. Leave the `renderHtml` parser field as the legacy pass-through flag for now.

Reasoning:

Making HTML raw by default changes the expectations for ordinary local HTML files. If common HTML files lose styles/images/scripts by default, the feature will feel broken even though self-contained generated HTML works.

## Deferred Work

These are useful but not necessary for the first high-quality pass:

- Package local assets into remote share payloads.
- Inline local assets as data URLs for share.
- Rewrite CSS `url(...)` inside inline `<style>` blocks or `style=""` attributes.
- Support root-relative site assets.
- Support iframe navigation to sibling HTML while preserving the Plannotator annotation bridge.

## Overall Effort Estimate

P1 remote raw HTML sharing:

- 2-4 hours.

P2 local asset serving and parse5 rewriting:

- 1-2 days.

Docs/comments and parser cleanup:

- 1-2 hours.

Total recommended scope:

- roughly 1.5-2.5 engineering days, depending on test depth and how strict we are about asset MIME support.

If we defer local asset support:

- roughly half a day, but the PR should explicitly document that raw HTML mode currently expects self-contained HTML or external assets.
