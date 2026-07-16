# 005. Publish the document UI as `@plannotator/ui` + `@plannotator/core`

Date: 2026-07-01

## Status

Accepted

## Context

The commercial Workspaces app (Cloudflare Workers + D1 + R2 + Durable Objects, WorkOS identity, Yjs realtime) needs Plannotator's document UI: the markdown rendering engine, the annotation/comment machinery, the markdown editor, and the theme. Plannotator's open-source experience must not change while making that possible.

Two approaches were on the table:

1. **Copy/vendor** — fork the UI source into the Workspaces repo (an earlier from-scratch reimplementation of this UI was attempted, broke the app, and was reverted).
2. **Publish** — make the UI an installable package with host-override seams.

Copy/vendor loses on two facts we've since measured:

- **The reusable pieces sit deep in the package graph.** `packages/ui` imported freely from `@plannotator/shared`, which is Node-bound (fs/git/server). A copy would have to sever those imports by hand and re-sever them on every sync.
- **Main moves too fast for a fork.** During the packaging PR (#957) alone, the branch was rebased onto main **four times** (46 commits, then #979/#980, #981/#983, #878 + the 0.21.4 release). A vendored copy would already be four syncs behind; every UI feature landing on main (math rendering, parser hardening, PR-context work) would need manual porting.

Seams beat surgery for the same reason: an override point whose default *is* today's code keeps one source of truth, whereas editing call sites per-consumer creates two.

## Decision

Publish two packages, keep one private, and decouple via seams — never rewrite:

- **`@plannotator/core`** — browser-safe, zero-dependency pure utils + types, carved out of `@plannotator/shared` with `git mv`. CI typechecks it without `@types/node` so a `node:` import cannot sneak in. Published.
- **`@plannotator/ui`** — the React components, hooks, theme, and `configurePlannotatorUI()`. Depends on `core`. Published.
- **`@plannotator/shared`** — stays private; re-exports the moved core modules via one-line shims (`export * from '@plannotator/core/x'`), so none of Plannotator's ~99 internal import sites changed.

**The seam pattern:** every place the UI touches a backend is a module-level singleton with a setter — `let impl = default; setX(); resetX(); getX()` — where the default reproduces Plannotator's literal behavior (`/api/*` over fetch). Plannotator passes nothing and stays byte-for-byte unchanged; a host calls `configurePlannotatorUI({...})` once at startup. Seams shipped: storage, identity (incl. `isEditable`), image resolving, uploads, doc previews, file tree, drafts, external annotations, AI transport, server sync.

**Singleton, not a React Provider — with a named revisit condition:** module-level state is safe for client-side apps (one user per browser). It is wrong under SSR, where one server process renders for many users. Neither Plannotator nor Workspaces does SSR. **If SSR is ever added for this UI, that is the trigger to introduce a `<PlannotatorUIServices>` provider** and turn `configurePlannotatorUI` into a compatibility shim over it. Until then the complexity is not paid.

**The law** (guardrails, enforced socially and by CI where possible):

1. Don't reimplement the document UI from scratch — add a seam.
2. Every seam's default must reproduce today's Plannotator behavior.
3. `@plannotator/core` stays browser-safe and zero-dep — no `node:` imports.
4. Never delete working Plannotator code until a human confirms parity in the browser.

**Publish model:** both packages version **in lockstep with the repo** (currently 0.21.4). They ship TypeScript source (consumers bundle it); `styles.css` is precompiled by `prepack`. `workspace:*` inter-deps must resolve to exact versions at publish time, so the flow is `bun pm pack` then `npm publish *.tgz --provenance --access public`, **`core` first, then `ui`**. First publish is manual from `main` after merge; a CI publish job is a follow-up.

## Consequences

- Workspaces installs the packages and plugs in its Cloudflare backend (localStorage settings, WorkOS identity with `isEditable() => false`, R2 uploads, D1 doc previews, DO-backed annotation transport) without forking. Its repo writes the matching consumer-side ADR.
- The published exports map is broad; **importable ≠ supported**. The supported-import allowlist and the unsupported "calls Plannotator's local server" list live in `packages/ui/HANDOFF.md`, alongside the annotation anchor schema and the editor/Yjs status. Restructuring exports was deliberately deferred.
- Known rough edges accepted for v1 (documented in HANDOFF.md): `AITransport`/`FileTreeBackend` leak `Response` objects; the markdown editor doesn't yet accept CM6 extensions (live collab lands via a later atomic PR threading `extensions?` through both wrapper layers after `@plannotator/markdown-editor` is imported into the monorepo).
- Every future "the host needs different behavior" request has one sanctioned shape: add an optional seam in a Plannotator PR whose default is today's behavior.
- Version lockstep means UI releases are repo releases; publishing stays owner-authorized.

## References

- PR #957 (`feat/pkg-document-ui`)
- `packages/ui/HANDOFF.md` — consumer handoff (seam catalog, supported imports, anchor schema)
- `packages/ui/README.md`, `packages/ui/CLAUDE.md` — the short version next to the code
