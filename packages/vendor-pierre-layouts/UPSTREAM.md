# Upstream record: @pierre/layouts

Facts about the copy under `upstream/`. `scripts/check-vendored-pierre-layouts.ts` reads this file: keep the `- Commit:`
line and the `sha256` block in their form.

- Package: `@pierre/layouts`, version `0.0.0`, `"private": true` (not on npm)
- Repository: https://github.com/pierrecomputer/pierre
- Branch: `necolas/layout`
- Commit: `a745a6171d256822f895a06d5a3f0fdafda77d58`
- Commit date: 2026-11-13 18:36:12 -0800
- Copied on: 2026-11-15
- Path copied: `packages/layouts/` (by `git archive <commit> packages/layouts`)
- License: Apache-2.0 (`upstream/LICENSE.md`, verbatim; the same text as the repository root's `LICENSE.md`).
  Upstream has no NOTICE file. Our attribution is `NOTICE` in this folder.
- Runtime dependencies: none. Peer: `react ^19` (optional). Nothing was added to our lockfile.
- Patches: none (`patches/` is empty).

## What was copied

`src/` whole (overlays included, though nothing imports them, so the copy stays one verbatim tree), `package.json`,
`README.md`, `consumer-guide.md`, `LICENSE.md`.

## What was left out

| Upstream path | Why |
|---|---|
| `packages/layouts/test/` | Their unit (Vitest-style) and Playwright suites; they run in their repo, not ours |
| `packages/layouts/bench/` | Benchmarks and results (18 MB) |
| `packages/layouts/demo/` | Their playground; it imports their other packages (`@pierre/trees`, `@pierre/diffs`, xterm) |
| `packages/layouts/tsconfig.json`, `tsdown.config.ts`, `moon.yml` | Their build and task config; it extends their repo root and would confuse our tools |

## Manifest

Every file under `upstream/`, `shasum -a 256` format, paths relative to `upstream/`. Rewrite with
`bun scripts/check-vendored-pierre-layouts.ts --write` only after a deliberate update (README.md, "Update the mirror").

```sha256
13d92be18d5ceac526f33cc96b6902a14d168f3e1d4b16be738f0fa70da7fe98  LICENSE.md
a879663c585d022146965d918ad54d6a1aae07474c5118f19481e2022747df86  README.md
49c0f32e9c5eb05ba8835a225df7c6dd7946eb6cbe4fd426303d70bb4c89cbf9  consumer-guide.md
da4ab92527f400c2fc7f6159c0d1f01884322abb4bb6641fbb0546574cbf3ab9  package.json
871769776d2905898eb40301271cacc8272c5f68b1f4123672883ed80a78262b  src/css-layout.ts
9285a34ebaee87637bad63db53e1141f5a812e599cc3271acb0281c2487a6286  src/divide.ts
af6bbc67efe19b1007e902fc8d4badf404d5fe43ae56dd830565b64286fffd42  src/dom/flip.ts
83dfdec5dd37b9fe523dca3fc890ab93400493b2860fd07a967dd1a92714ed3a  src/dom/panes.ts
7a96e01b568c1751b84be3621d364c36b33d5abdf7e42a281c471bc2c7ec8486  src/dom/resize-work.ts
b2511ec87a9458d649b6bf35a933187039632896e8b29b5277241847b393356e  src/dom/tab-drag.ts
dff6752cd1144bb8f2325876a2ec1c43370e1c2365296376160baeed025fcce1  src/geometry.ts
45917249b69183ce4b522bca77a286bd51da810f6719d5c02682dda7e5ec8a1c  src/gestures.ts
9568edd5aefcd01a5e75848779d5d2c932fee8d0fe1d03087fcddb2ad3e10092  src/index.ts
785ffc089da278e9c21903f728e98cbcb18f4463be9204df58e90a0f72368e6c  src/model.ts
7946b9ba33f0c383edb15fa94b1dfd3316896378fce3bc7178c271b54e7e1f5d  src/models/binary.ts
78e7ba5c6d758f19e4e16fccc32e4683ad4fe14b50d767a00c5cafb5782912be  src/models/n-ary.ts
eb0d23d357891a487aabff495fd2bea00d473ef250b1ed023533efd756a2a8e2  src/operations.ts
e7cb48e2fca540925bf9d58c07b8fc35a9c923e3faca6600afc998f8bc1873a4  src/overlays.css
e6e7c638d34cae54bc69c65e7de3b2f5fcedbea102e6b57d1f0cccc60d63242f  src/overlays/index.ts
90f23de230930ca3f11698c96095ec5bac8b8113c18acfbde9e9584d56297cd9  src/piecewise.ts
173c6d5ac30ea8c5bc265e9ebaf80ff116a837085986800096752165fd1cffa5  src/react/index.tsx
59ef5a1133a9f8e18a7e1988161bbc5cf0b1d08165cddef921aa6d8e1af62af6  src/react/overlays.tsx
c382095377aa7215e8567b1765ecd1d3e1a61434b5c10d80fdf335a8f53624a1  src/reconcile.ts
1afbdcc18fc3848ab5d4be877bc71ab04357e64f03039cd640eea454933591a0  src/store.ts
19ae0fa525435768585a38c843e85cb527886abdc32088a8a52e020913a96b37  src/stored-tree.ts
e95be41f28f46be845d873a32096ef4da1eea7b7d9311457d9337848e99f6495  src/styles.css
8c6564eb184d1bf4f823635a7e38bd8c2b21126e8b3a6d197a5480155503fdd8  src/types.ts
054374ad66452a1cb4816f06635dc591afbcb01d389093fb02b8778058f54724  src/view.ts
```
