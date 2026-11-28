# The app contract

This folder is the one source that the native app and the window are both built from. It holds data only. The guide is [`docs/agent-guides/mobile.md`](../../../docs/agent-guides/mobile.md).

| File | Generated | How |
|---|---|---|
| `VERSION` | yes | `bun scripts/mobile/door.ts`, from the door's `DOOR_CONTRACT` |
| `door.json` | yes | `bun scripts/mobile/door.ts` |
| `schema/wire.schema.json` | yes | `bun scripts/mobile/schema.ts` |
| `generated/swift/Wire.swift` | yes | `bun scripts/mobile/swift.ts` (run it after the two above) |
| `tokens/tokens.json`, `generated/swift/Tokens.xcassets/` | yes | `bun scripts/mobile/tokens.ts` |
| `words/words.json`, `generated/swift/Words.swift` | yes | `bun scripts/mobile/words.ts` |
| `parity/surface.json` | yes | `bun scripts/mobile/surface.ts` |
| `parity/ledger.json` | partly | One row per feature with the phone's decision. `bun scripts/mobile/all.ts` adds new entries as undecided; `bun scripts/mobile/check.ts` checks it covers the surface. |
| `flows/*.md` | no | One file per flow with numbered checks. |
| `fixtures/*.json` | no | Invented inputs for the conformance suites. |
| `vectors/*.json` | yes | `bun scripts/mobile/vectors.ts` and `bun scripts/mobile/vectors-stream.ts` |

Do not edit a generated file. Change its source in the product, or a generator in `scripts/mobile/`, then run `bun scripts/mobile/all.ts`. `bun scripts/mobile/check.ts` (the mobile-contract workflow, never a unit test) fails when a generated file is stale.
