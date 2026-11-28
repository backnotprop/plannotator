# vendor-pierre-layouts: a pinned mirror of @pierre/layouts

`@pierre/layouts` is Pierre's split-pane layout engine: a tree of panes, tab stacks and splits, with drag to move,
constrained resizing, zoom, tabs and save/restore, plus a React view (`<Layout>`). It is Apache-2.0, but it is
`private`, version `0.0.0`, and not on npm, so we cannot depend on it. This folder holds a copy of its source at one
commit, unchanged, and a thin wrapper that our code imports.

Status: used by the Inbox's free layout of thread panes (`packages/inbox/panes/FreeLayout.tsx` and the modules beside
it), behind config.json `inboxSplitView`, off by default (docs/agent-guides/inbox-window.md, "Free layout"). Local
changes: none to `upstream/`; `src/` only re-exports it, and the Inbox's look over the engine's sheet lives in
`packages/inbox/panes/panes.css`. See "Who decides" before using it anywhere else.

## Layout

| Path | What | Who edits it |
|---|---|---|
| `upstream/` | Their files, byte for byte as `git archive` gave them | Nobody. Only a mirror update replaces it |
| `UPSTREAM.md` | Repo, branch, commit, date, license, files left out, and a sha256 manifest of `upstream/` | The update steps below |
| `src/` | Our wrapper: `index.ts` (core), `react.ts` (`<Layout>`), `styles.css` (their sheet) | Us |
| `patches/` | Our changes to their code, one `.patch` per change with a `# why:` first line. Empty today | Us |
| `NOTICE` | Attribution required by Apache-2.0 | The update steps |
| `.gitattributes` | Keeps `upstream/` bytes exact on Windows checkouts | Nobody |
| `package.json` | The private workspace package; `exports` lead to `src/` | Us |

`package.json` makes the folder a private workspace package, `@plannotator/vendor-pierre-layouts`, never published. Its
`exports` point at `src/` only, and it lists `react` (the version the Inbox already uses) so that upstream's
`import 'react'` resolves under Bun's isolated linker; it adds no package to `bun.lock`. A package that uses the
engine lists `"@plannotator/vendor-pierre-layouts": "workspace:*"` (today: `packages/inbox`).

## Rules

1. Never edit a file under `upstream/`, not even to format it. `scripts/check-vendored-pierre-layouts.test.ts` fails
   on any edit, added file or removed file. Their code keeps their style; our formatters must not touch it.
2. App code imports only the package's names (`@plannotator/vendor-pierre-layouts`, `.../react`, `.../styles.css`),
   which lead to `src/`, never a path into `upstream/`. The same test fails otherwise. This is what makes the switch
   to the npm package a change of three lines.
3. A change to their code is a patch in `patches/`, listed in `UPSTREAM.md`, and offered upstream. See "Patching".

Check the mirror at any time:

```sh
bun scripts/check-vendored-pierre-layouts.ts
```

It prints the pinned commit and exits 1 if `upstream/` differs from the manifest.

## Check against upstream

Do this before an update, or to learn whether we are behind. All of it happens in a scratch folder outside this repo.

1. Read the pinned commit and branch from `UPSTREAM.md`:

   ```sh
   grep -E '^- (Branch|Commit):' packages/vendor-pierre-layouts/UPSTREAM.md
   ```

2. Fetch upstream into a scratch folder (the repo is public; a blobless clone is enough):

   ```sh
   git clone --filter=blob:none --branch necolas/layout https://github.com/pierrecomputer/pierre.git /tmp/pierre-upstream
   ```

   If the branch is gone, the package has probably moved to `main`: `git -C /tmp/pierre-upstream branch -r`, and
   `git -C /tmp/pierre-upstream log --oneline -5 origin/main -- packages/layouts`.

3. Confirm our copy is exactly the pinned commit (expect no output):

   ```sh
   PIN=$(sed -n 's/^- Commit: `\([0-9a-f]*\)`.*/\1/p' packages/vendor-pierre-layouts/UPSTREAM.md)
   mkdir -p /tmp/pierre-pinned && git -C /tmp/pierre-upstream archive "$PIN" packages/layouts | tar -x -C /tmp/pierre-pinned
   for f in src package.json README.md consumer-guide.md LICENSE.md; do
     diff -r "/tmp/pierre-pinned/packages/layouts/$f" "packages/vendor-pierre-layouts/upstream/$f"
   done
   ```

4. See what changed upstream since the pin:

   ```sh
   git -C /tmp/pierre-upstream log --oneline "$PIN"..origin/necolas/layout -- packages/layouts
   git -C /tmp/pierre-upstream diff --stat "$PIN" origin/necolas/layout -- packages/layouts/src
   git -C /tmp/pierre-upstream diff "$PIN" origin/necolas/layout -- packages/layouts/src/index.ts packages/layouts/src/types.ts packages/layouts/src/store.ts packages/layouts/src/react/index.tsx
   ```

5. What to look for in that diff:
   - The public surface: exports of `src/index.ts` and `src/react/index.tsx`, `LayoutProps`, `PaneHeaderProps`, the
     `LayoutStore` methods, and the node types in `src/types.ts`. A removed or renamed member is a break for us (in
     the two weeks before the pin, `setRatios` became `setSizes`, and split nodes went from `ratio/first/second` to
     `children/sizes`).
   - The saved form (`serialize`/`restore`, `stored-tree.ts`): a new version must still read our saved layouts.
     Upstream's `restore` has so far accepted every older version.
   - `styles.css`: renamed classes or `--layout-*` variables break our theme mapping.
   - `package.json`: a new runtime dependency means we stop and ask before updating (we add no packages silently).
   - Their `README.md` and `consumer-guide.md`: they document every behaviour change; read their diff whole.
   - Whether the package was published (`"private"` gone, a version other than `0.0.0`, or
     `npm view @pierre/layouts version` answers): then retire the mirror instead of updating it.

## Update the mirror

1. Do "Check against upstream" first and pick the new commit (`NEW`), ideally one their CI passed.
2. Replace `upstream/` with that commit's files, the same set as before (see "What was copied" in `UPSTREAM.md`).
   Move the old copy aside (never delete in place without review), then:

   ```sh
   rm -rf /tmp/pierre-new && mkdir -p /tmp/pierre-new
   git -C /tmp/pierre-upstream archive "$NEW" packages/layouts | tar -x -C /tmp/pierre-new
   mkdir -p packages/vendor-pierre-layouts/upstream
   cp -R /tmp/pierre-new/packages/layouts/src packages/vendor-pierre-layouts/upstream/src
   cp /tmp/pierre-new/packages/layouts/{package.json,README.md,consumer-guide.md,LICENSE.md} packages/vendor-pierre-layouts/upstream/
   ```

3. Re-apply each patch in `patches/` (see "Patching"); a patch that no longer applies is redone by hand or dropped if
   upstream fixed the issue.
4. Edit `UPSTREAM.md` (commit, commit date, copied on, any change to what was copied or left out) and `NOTICE` (the
   commit). Then record the manifest and check it:

   ```sh
   bun scripts/check-vendored-pierre-layouts.ts --write
   bun scripts/check-vendored-pierre-layouts.ts
   ```

5. Typecheck and test what uses it: `tsc --noEmit -p packages/inbox/tsconfig.json`,
   `bun test scripts/check-vendored-pierre-layouts.test.ts`, and the tests of the code that imports `src/`.
6. Open the layout in a browser (a sandboxed Inbox with `inboxSplitView` on; `tests/e2e/inbox-open-beside.spec.ts`
   shows one) and try a row dropped on a pane, a pane moved by its header, a divider resized, a close, and a reload
   that restores the layout.

What usually breaks: renamed store methods or props (fix our call sites, never their code), a changed saved-tree version
(test a layout saved by the old copy), renamed CSS classes or variables (our theme mapping), and a stricter TypeScript
setting in their code than ours, or the reverse (our `tsconfig` checks their files when we import them).

## Patching

Prefer no patch: wrap in `src/`, or ask upstream. When a patch is unavoidable:

- Write it as a `git diff` against `upstream/` (paths relative to `upstream/`), first line `# why: <one line>`, saved as
  `patches/NNN-short-name.patch`, and list it in `UPSTREAM.md` under "Patches".
- Apply it into a generated `patched/` copy (`cp -R upstream patched && git apply --directory=... patches/*.patch`),
  point `src/` at `patched/`, and add `patched/` to `.gitignore` or regenerate it in the build. Keep `upstream/` exact.
- Offer the change upstream, and drop the patch when they take it.

## Retire the mirror (when @pierre/layouts is on npm)

1. Add the package: `bun add @pierre/layouts@<version>` in the package that uses it (`packages/inbox`, or wherever the
   layout lives by then). Mind `minimumReleaseAge` in `bunfig.toml`: a fresh release waits 7 days unless excluded there,
   as the other `@pierre/*` packages are.
2. Point the wrapper at it: in `src/index.ts` `export * from '@pierre/layouts'`, in `src/react.ts`
   `export * from '@pierre/layouts/react'`, in `src/styles.css` `@import "@pierre/layouts/styles.css"`, and add
   `@pierre/layouts` to this package's `dependencies`. Or, simpler once nothing needs a wrapper: replace every import
   of `@plannotator/vendor-pierre-layouts` with `@pierre/layouts` and remove this package from its users.
3. Move `upstream/`, `UPSTREAM.md`, `patches/`, `NOTICE` and `.gitattributes` out (the whole folder, if step 2 took
   the second way), then `scripts/check-vendored-pierre-layouts.ts` and its test.
4. Verify: `git grep -n vendor-pierre-layouts` finds nothing you did not mean to keep, the typecheck passes, the
   layout works in the browser, and a layout saved before the switch restores after it.

## Known gaps we work around

- No drop from outside the layout: a list row cannot be dropped into it by the engine. The Inbox's one thread drag
  (`packages/inbox/threadDrag.ts`, with `panes/paneDrop.ts` its pane target; a pane moves by `panes/paneDrag.ts`) hit-tests the pane under the pointer and changes its own
  tree, which it pushes into the store (`setRoot`). The engine's own pane drag (its header grip) is not used: the
  Inbox draws no engine header (`renderHeader` returns nothing) and moves panes by the thread's header instead.
- No keyboard way to move a pane to another place (resizing is keyboard-reachable). The Inbox's pane ⋯ menu has Move
  left/right/up/down.
- A pane has no payload: the Inbox maps pane ids to threads (`panes/layoutModel.ts`).
- Each pane host is a containing block (`transform`), so `position: fixed` content is fixed to the pane. The Inbox sets
  the host's transform to none; the root's `container-type: size` still contains fixed content, so a full-screen file
  draws the Inbox's one-pane path instead of the layout.
- Its `getMinimumSize` and drop-place helpers are not exported; the Inbox has its own (`panes/layoutRoom.ts`).

## Who decides

The repo owner decides where the engine is used, each mirror update, and its retirement. An agent may run "Check
against upstream" at any time and report; it does not update or retire the mirror on its own.
