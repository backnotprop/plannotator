# The app contract

This folder is the one source that the native app and the window are both built from. It holds data only. The guide is [`docs/agent-guides/mobile.md`](../../../docs/agent-guides/mobile.md).

| File | Generated | How |
|---|---|---|
| `VERSION` | no | The contract number. |
| `door.json` | yes | `bun scripts/mobile/door.ts` |
| `schema/wire.schema.json` | yes | `bun scripts/mobile/schema.ts` |
| `generated/swift/Wire.swift` | yes | `bun scripts/mobile/swift.ts` (run it after the two above) |

Do not edit a generated file. Change its source in the product, or a generator in `scripts/mobile/`, then run the generators. `tests/mobile-vectors.test.ts` fails when a generated file is stale.
