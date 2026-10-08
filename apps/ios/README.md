# Plannotator for iPhone

The Plannotator Inbox on a phone: pair with the Inbox on your computer, read
the threads agents leave there, pick answers with one tap and send them.
SwiftUI, iOS 26, bundle id `ai.plannotator.app`. The wire it speaks is
`adr/implementation/inbox-mobile.md`; the design of record is
`.product/approved/plannotator-mobile-iphone-2026-10-07/` in the Workspaces
meta repo.

## Layout

- `project.yml`: the project, for [XcodeGen](https://github.com/yonaskolb/XcodeGen).
  `Plannotator.xcodeproj` is generated from it and committed, so a fresh clone
  builds with `xcodebuild` alone. After changing `project.yml` or adding a
  file, run `xcodegen generate` here and commit both.
- `Plannotator/`: the app. `App/` holds the model (paired sources, the shown
  source's list and threads, the event stream, Send's idempotency keys, the
  cache); `Inbox/`, `Thread/`, `Pairing/` and `Settings/` hold the screens;
  `Attachments/` holds the surface host (one `WKWebView` with Plannotator's
  bundled surface, its two URL schemes and the bridge) and the attachment
  screens (4.1 to 4.4, the "N annotations" sheet).
- The surface: a build phase runs `apps/inbox`'s `build:surface` when its
  sources are newer than `apps/inbox/dist/surface.html`, and copies that file
  into the app as `surface.html`. It needs `bun` on the PATH Xcode gives
  scripts (`~/.bun/bin` and `/opt/homebrew/bin` are added).
- `PlannotatorKit/`: a local Swift package with the device-door client, the
  wire models, the event stream, the `plannotator://pair` link, the Keychain
  item and the markdown splitter. No third-party dependencies.
- `PlannotatorUITests/`: the XCUITest proof.
- `Plannotator/Colors.xcassets`: generated from
  `packages/ui/themes/plannotator.css` by `bun apps/ios/scripts/gen-colors.ts`;
  `--check` fails when the theme moved and the catalog did not.

## Build and run

```bash
xcodebuild -project apps/ios/Plannotator.xcodeproj -scheme Plannotator \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

The simulator reaches the Mac's own Inbox at `127.0.0.1:<port>` (Find it
nearby, then type the address and the six digits the Inbox shows under Pair a
phone). A phone reaches it over the tailnet once "Reach from my tailnet" is on.

## The proof

```bash
bun run --cwd apps/review build && bun run build:hook && \
  bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
  --define '__CLI_VERSION__="0.0.0-dev"' --outfile .local/plannotator
bun apps/ios/scripts/proof.ts --binary .local/plannotator
```

It starts that binary's Inbox under a temp data dir, connects agents through
`plannotator inbox mcp`, makes a fresh simulator and runs `xcodebuild test`:
the PlannotatorKit tests, then the flows: pairing and answering (pair by typed
address and code, the list, "2 new" while scrolled, a swipe, picks, a note,
Other, Send and the agent's `wait_for_reply`, Resolve, Delete, removal on the
computer, pairing again, Remove this source), and attachments (an agent sends
`scripts/fixtures`' plan, ticket page and Mermaid flow; a comment on each by
touch; the changed line and the sent version; links; Share; the page's forged
bridge messages dropped; the "3 annotations" sheet opening a file at its mark;
Send, with the agent's feedback naming all three). `--only
PlannotatorUITests/AttachmentProofTests` runs one. Light and dark screenshots of each screen and a
recording of the pair-pick-send flow land in `.local/proof/ios/`. CI runs the
same command (`.github/workflows/ios.yml`).

## Version

`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml`. The app is
private to this repo and stays out of the release-bumped files.
