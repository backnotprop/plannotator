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
  cache); `Inbox/`, `Thread/`, `Pairing/` and `Settings/` hold the screens.
- `PlannotatorKit/`: a local Swift package with the device-door client, the
  wire models, the event stream, the `plannotator://pair` link, the Keychain
  item and the markdown splitter. No third-party dependencies.
- `PlannotatorNotifications/`: the notification service extension. It opens
  a relay push's envelope with the device key derived from the pairing secret
  (kept in the Keychain group `group.ai.plannotator.app`, shared with the
  app), writes the subject and "<agent> in <project>", and gives a message
  with one single-choice question its choices as actions. With previews
  hidden every notification reads "Question from an agent".
- `PlannotatorUITests/`: the XCUITest proof.
- `Plannotator/Colors.xcassets`: generated from
  `packages/ui/themes/plannotator.css` by `bun apps/ios/scripts/gen-colors.ts`;
  `--check` fails when the theme moved and the catalog did not.

## What you need to run it

Xcode 26 with the iOS 26 simulator runtime (Xcode, Settings, Components), and
`bun` for the scripts. `xcodegen` (`brew install xcodegen`) only when you change
`project.yml` or add a file: the generated project is committed. The proof also
needs a compiled `plannotator` binary from this checkout (below), never the one
on your PATH. A simulator build needs no Apple account and no signing; a device
build needs your own team in Xcode.

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
the PlannotatorKit tests, then the flow (pair by typed address and code, the
list, "2 new" while scrolled, a swipe, picks, a note, Other, Send and the
agent's `wait_for_reply`, Resolve, Delete, removal on the computer, pairing
again, Remove this source). Light and dark screenshots of each screen and a
recording of the pair-pick-send flow land in `.local/proof/ios/`. CI runs the
same command (`.github/workflows/ios.yml`).

The script also runs the relay (`apps/relay`) under `wrangler dev`, with a
local HTTP/2 server standing in for APNs, and points the Inbox at it. The
notification flow (`RelayPushTests`) pairs, turns on Allow notifications (the
token reaches the relay), has agents ask, and hands the exact body Apple
received to `xcrun simctl push`: the lock screen, the choices, a choice that
reaches the agent's `wait_for_reply`, one that goes up through the relay when
the computer cannot be reached directly, a tap that opens the thread, and
previews hidden. `simctl push` never runs a
notification service extension, so in the simulator a push that arrives while
the app is in front is dressed by the app with the extension's code; the
extension under a real push and Face ID before a choice need a signed build
on a phone. `--only PlannotatorUITests/RelayPushTests` runs that flow alone.

## Release and App Review

- `Plannotator/PrivacyInfo.xcprivacy`: the privacy manifest (no tracking, no
  collected data, `UserDefaults` for the app's own settings only). Each
  bundle whose code uses a required-reason API needs its own.
- `APP-REVIEW.md`: what App Review is told, and the privacy and export
  compliance answers.
- `RELEASE.md`: the release runbook the owner runs himself (the Apple account,
  the keys, the archive, the upload, TestFlight, the submission).

## Version

`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml`. The app is
private to this repo and stays out of the release-bumped files.
