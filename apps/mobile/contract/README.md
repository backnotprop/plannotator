# The app contract

This folder is the one source that the native app and the window are both built from. It holds data only. The guide is [`docs/agent-guides/mobile.md`](../../../docs/agent-guides/mobile.md).

| File | Generated | How |
|---|---|---|
| `VERSION` | no | The contract number. |
| `door.json` | yes | `bun scripts/mobile/door.ts` |
| `schema/wire.schema.json` | yes | `bun scripts/mobile/schema.ts` |
| `generated/swift/Wire.swift` | yes | `bun scripts/mobile/swift.ts` (run it after the two above) |
| `tokens/tokens.json`, `generated/swift/Tokens.xcassets/` | yes | `bun scripts/mobile/tokens.ts` |
| `words/words.json`, `generated/swift/Words.swift` | yes | `bun scripts/mobile/words.ts` |
| `parity/surface.json` | yes | `bun scripts/mobile/surface.ts` |
| `parity/ledger.json` | no | One row per feature with the phone's decision; `tests/mobile-parity.test.ts` checks it covers the surface. |
| `flows/*.md` | no | One file per flow with numbered checks. |

Do not edit a generated file. Change its source in the product, or a generator in `scripts/mobile/`, then run the generators. `tests/mobile-vectors.test.ts` fails when a generated file is stale.
