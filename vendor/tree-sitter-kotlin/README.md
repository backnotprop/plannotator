# tree-sitter-kotlin 1.1.0 (vendored)

`tree-sitter-kotlin.wasm` is the release asset of [tree-sitter-grammars/tree-sitter-kotlin](https://github.com/tree-sitter-grammars/tree-sitter-kotlin), tag `v1.1.0` (commit 77dd60e), unchanged:
<https://github.com/tree-sitter-grammars/tree-sitter-kotlin/releases/download/v1.1.0/tree-sitter-kotlin.wasm>

- sha256: `7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7` (also in `SHA256SUMS`)
- Size: 3,441,042 bytes
- Licence: MIT (`LICENSE`, from the same release)

It is byte-identical to the `tree-sitter-kotlin.wasm` in the npm package `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0, the file the Kotlin engine was scored with. It is vendored because that npm package declares `npm-check-updates` as a runtime dependency, which would install with the app. The file is installed as a local `file:` dependency under the same name, `@tree-sitter-grammars/tree-sitter-kotlin`, so the engine loads it as `@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm`, as before.

## Updating

1. Download the new release asset: `gh release download <tag> -R tree-sitter-grammars/tree-sitter-kotlin -p tree-sitter-kotlin.wasm`, and take `LICENSE` from the same tag.
2. Replace `tree-sitter-kotlin.wasm` (and `LICENSE` if it changed) here, and set `version` in `package.json` to the tag.
3. Update `SHA256SUMS`: `shasum -a 256 tree-sitter-kotlin.wasm > SHA256SUMS`.
4. Put the new sha256 in the pinned checks: `packages/sem-diff/test/kotlin.test.ts` and `packages/sem-diff/scripts/copy-wasm.ts`.
5. Reinstall (`bun install`). Then run the engine tests, including the Kotlin trap cases, and `copy-wasm` (`bun packages/sem-diff/scripts/copy-wasm.ts <out dir>`), which refuses a file whose sha256 does not match.
