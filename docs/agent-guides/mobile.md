# The native app's contract kit

The native iPhone app of the Plannotator Inbox lives in `apps/mobile/`. It is built from one source with the window: `apps/mobile/contract/`. That folder holds data only (JSON, Markdown, generated Swift). Generators in `scripts/mobile/` make it from the product's own TypeScript. Two Bun tests fail when the product changes and the contract does not.

The Inbox is Bun-only. Nothing here has a Pi twin.

## The standing rules

- Swift never has a hand-written wire type, route string, error code, color or product word. These come from `apps/mobile/contract/generated/`.
- Never read the window's React code to copy a rule. If a rule is not in the contract, add it to the contract first (a type, a door entry, a vector or a flow check). Then build the app from it.
- Every change to the wire is additive. An old app reads a newer Inbox: generated structs keep unknown fields, generated enums have `unknown(String)`, optional fields stay optional.
- Do not edit a file marked GENERATED. Change its source and run its generator.

## What is in `apps/mobile/contract/`

| Path | Made by | From |
|---|---|---|
| `VERSION` | hand | The contract number, a whole number. Increase it only when an app built from the older contract would misread the door. |
| `door.json` | `scripts/mobile/door.ts` | The door's own route list (`doorRouteNames`, `doorRouteOf`, `doorWriteRoutes` in `packages/server/inbox-devices.ts`) and the write kinds (`DOOR_WRITES` in `packages/server/inbox-outbox.ts`). One entry per route, alternations written out. |
| `schema/wire.schema.json` | `scripts/mobile/schema.ts` | The product's TypeScript types named in `ROOTS`, and every type they reach. It uses the TypeScript 5.8 compiler that `packages/core` installs. |
| `generated/swift/Wire.swift` | `scripts/mobile/swift.ts` | The schema, `door.json`, and the error codes of the door (`refuse(…)`) and the window (`ERROR_STATUS` in `packages/server/inbox.ts`). |

`scripts/mobile/door-shapes.ts` declares the few door shapes that the product has no TypeScript type for: the pair exchange, the error body, the stream frames, and the bodies of `seen`, `picks` and `reply`. If the product gets a type for one of these, use the product's type in `ROOTS` and remove the shape from `door-shapes.ts`.

## Commands

```sh
bun scripts/mobile/door.ts      # door.json
bun scripts/mobile/schema.ts    # schema/wire.schema.json
bun scripts/mobile/swift.ts     # generated/swift/Wire.swift (reads the two above: run it last)
```

Add `--check` to compare with the committed files without writing. The command fails and names the stale files.

## When a test fails on your pull request

`tests/mobile-vectors.test.ts` runs every generator with its check. It runs in an ordinary unit lane: `scripts/ci-affected.ts` selects it when a file the generators import or name changes, for example the door, the outbox's write kinds, the wire types (`packages/core/inbox-types.ts`, `packages/core/inbox-wire-models.ts`) or the window's error table. A change to the window's or the shared UI's own code does not select it. It takes about a second.

If it fails with "is up to date (else: bun scripts/mobile/<name>.ts)":

1. Run the three generators in the order above.
2. Read the diff of `apps/mobile/contract/`. A new route, field or code is something the phone must decide about.
3. Commit the regenerated files in the same pull request.

## CI

- The contract files are data. The test picker reads them like any other data file. Only `.github/workflows/mobile-ios.yml` builds Swift, and only when `apps/mobile/**` changes. It is never a required check.
- `apps/mobile/ios/ci.sh` typechecks `Wire.swift` on that job.
- A generator never lists a folder of the checkout. Every path it reads or writes is a literal in `scripts/mobile/lib.ts` or in the generator, so the picker can see it. If a generator lists a folder, every pull request runs the contract test.
