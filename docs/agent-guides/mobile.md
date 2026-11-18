# The native app's contract kit

The native iPhone app of the Plannotator Inbox lives in `apps/mobile/`. It is built from one source with the window: `apps/mobile/contract/`. That folder holds data only (JSON, Markdown, generated Swift). Generators in `scripts/mobile/` make it from the product's own TypeScript. Two Bun tests fail when the product changes and the contract does not: `tests/mobile-vectors.test.ts` (a generated file is stale) and `tests/mobile-parity.test.ts` (the window gained something the phone has no decision for).

The Inbox is Bun-only. Nothing here has a Pi twin.

## The standing rules

- Swift never has a hand-written wire type, route string, error code, color or product word. These come from `apps/mobile/contract/generated/`: `Wire.swift`, `Words.swift` and `Tokens.xcassets`.
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
| `tokens/tokens.json`, `generated/swift/Tokens.xcassets/` | `scripts/mobile/tokens.ts` | The default theme, `packages/ui/themes/plannotator.css`, dark and light: every color as its CSS, Display P3 and sRGB hex, the radius in points and the font names. The catalog has one color set per color, light with a dark appearance. The other themes come later. |
| `words/words.json`, `generated/swift/Words.swift` | `scripts/mobile/words.ts` | The words the product exports as constants or pure functions: section names, agent names, Looks good, Action item, delivery lines and the failed-turn words. A word with a part (a name, a number) is made by calling the product's function with a marker, so `{name}` sits where the window prints the name. |

| `parity/surface.json` | `scripts/mobile/surface.ts` | Everything the window and its server offer, as `<kind>:<name>` entries: door routes, the Inbox endpoints (paths, read from the server's code by `scripts/mobile/window-routes.ts`; `tests/inbox-api-table.test.ts` holds `server-and-storage.md`'s Inbox table to the same list), stream frames, record kinds, wire enum values, the keys the Settings write takes, capabilities, wire fields, message blocks, `:::` blocks, Settings sections and flow checks. The door, the endpoints and the wire types are read live from the product. |
| `parity/ledger.json` | hand | One row per feature, with the phone's decision for it. See "The parity ledger". |
| `flows/*.md` | hand | One file per flow: what the person sees and does, then numbered checks such as `[list-04]`. `flows/README.md` holds the rules every flow keeps. |

`scripts/mobile/door-shapes.ts` declares the few door shapes that the product has no TypeScript type for: the pair exchange, the error body, the stream frames, and the bodies of `seen`, `picks` and `reply`. If the product gets a type for one of these, use the product's type in `ROOTS` and remove the shape from `door-shapes.ts`.

## Commands

```sh
bun scripts/mobile/door.ts      # door.json
bun scripts/mobile/schema.ts    # schema/wire.schema.json
bun scripts/mobile/swift.ts     # generated/swift/Wire.swift (reads the two above: run it after them)
bun scripts/mobile/tokens.ts    # tokens/tokens.json and the color catalog
bun scripts/mobile/words.ts     # words/words.json and Words.swift
bun scripts/mobile/surface.ts   # parity/surface.json
```

A word the window shows that is not in `words.json` is written inside a component or a server message. Make it a constant in the product first (that is a product change, in its own pull request), then add its row in `buildWords()`.

Add `--check` to compare with the committed files without writing. The command fails and names the stale files.

## The parity ledger

Every entry of `parity/surface.json` needs a row in `parity/ledger.json` that names it in `surface`. A row has:

- `id` and `title`;
- `surface`: the entries it decides;
- `flows`: the flow checks that prove it;
- `mobile`: `v1`, `rethink` (in v1, done the phone's way), `later` or `never`;
- `why`, which `later` and `never` must fill (SCOPE's reason codes: `L-door`, `L-off`, `L-size`, `L-ipad`, `L-ai`, `L-proxy`, `N-desk`, `N-web`, `N-self`; `L-nodoor` is a window endpoint that is not on the phone's door);
- `ios.state`: `not-started`, `building`, `done` or `owed`.

`owed` means the window changed something the app had, and the app has not caught up. It needs `owed_since` (a date), and the test fails when that date is more than 14 days old.

The seed (2026-11-18) is the owner's scope inventory: 1,221 rows with their marks and reasons. Entries were joined to rows by the routes, frames and fields each row names. Rows whose `source` starts with `seed:` cover the entries that no scope row names:

- wire fields grouped by type, which `Wire.swift` decodes;
- the window endpoints with no door route;
- the door routes, flows, blocks and frames left over.

When you fold such an entry into its feature's row, remove the seed row.

`tests/mobile-parity.test.ts` reads the live surface, not the committed file. It fails with:

> The window gained `<entry>`. Decide for the phone: add it to apps/mobile/contract/parity/ledger.json as v1, later, never or rethink

To fix it, add the entry to the feature's row, or to a new row with a mark. Then run `bun scripts/mobile/surface.ts`. A row that names an entry the window no longer has fails too. The test takes about half a second.

## When a test fails on your pull request

`tests/mobile-vectors.test.ts` runs every generator with its check. It runs in an ordinary unit lane: `scripts/ci-affected.ts` selects it when a file the generators import or name changes, for example the door, the outbox's write kinds, the wire types (`packages/core/inbox-types.ts`, `packages/core/inbox-wire-models.ts`), the window's error table, `plannotator.css` or a module a word comes from. A change to the window's or the shared UI's own code does not select it, and neither does a theme file other than `plannotator.css`. It takes about a second.

If it fails with "is up to date (else: bun scripts/mobile/<name>.ts)":

1. Run the generators in the order above.
2. Read the diff of `apps/mobile/contract/`. A new route, field or code is something the phone must decide about.
3. Commit the regenerated files in the same pull request.

## CI

- The contract files are data. The test picker reads them like any other data file. Only `.github/workflows/mobile-ios.yml` builds Swift, and only when `apps/mobile/**` changes. It is never a required check.
- `apps/mobile/ios/ci.sh` typechecks `Wire.swift` and `Words.swift` on that job.
- A generator never lists a folder of the checkout. Every path it reads or writes is a literal in `scripts/mobile/lib.ts` or in the generator, so the picker can see it. If a generator lists a folder, every pull request runs the contract test.
