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
  screens (4.1 to 4.4, the "N annotations" sheet); `Guides/` holds the
  guided review's cover (6.1, 6.2), on the same surface.
- The surface: a build phase runs `apps/inbox`'s `build:surface` when its
  sources are newer than `apps/inbox/dist/surface.html`, and copies that file
  into the app as `surface.html`. It needs `bun` on the PATH Xcode gives
  scripts (`~/.bun/bin` and `/opt/homebrew/bin` are added).
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
phone). A phone reaches a paired computer by the paths of 9.2, tried in order
when the app comes to the front, on pull to refresh and on a push: the same
Wi-Fi (the QR's `lan` address, its certificate pinned to the QR's `fp`), the
tailnet, then the Plannotator relay while its switch is on (on by default from
pairing; Allow notifications registers the push token only). Through the relay the app reads the items held
after the last one it read, applies their store lines to the threads it keeps,
reads the list and open threads as commands while the computer is online, and
sends its commands sealed with the same idempotency keys; a Send held for an
offline computer reads "Sent. Waiting for your computer" until it lands.

## The proof

```bash
bun run --cwd apps/review build && bun run build:hook && \
  bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
  --define '__CLI_VERSION__="0.0.0-dev"' --outfile .local/plannotator
bun apps/ios/scripts/proof.ts --binary .local/plannotator
```

It starts that binary's Inbox under a temp data dir, connects agents through
`plannotator inbox mcp`, makes a fresh simulator, builds once, runs
`WarmUpLaunch` alone (the app's first launch and first pairing, which take a
minute or more on a cold CI runner), then the rest: the PlannotatorKit tests,
then the flow (pair by typed address and code, the
list, "2 new" while scrolled, a swipe, picks, a note, Other, Send and the
agent's `wait_for_reply`, Resolve, Delete, removal on the computer, pairing
again, Remove this source), and the decisions and New message flow
(`DecisionsProofTests`: a Send with the switch off records nothing; the switch
on opens the decision card, and after Send the decision is in the Decisions tab
and in the window's own decisions route; New message to one live Claude Code
session, to the picked one of two, and the "not running" words for a project
with none), and attachments (`AttachmentProofTests`: an agent sends
`scripts/fixtures`' plan, ticket page and Mermaid flow; a comment on each by
touch; the changed line and the sent version; links; Share; the page's forged
bridge messages and its embed's beacons dropped; the "3 annotations" sheet
opening a file at its mark; Send, with the agent's feedback naming all three),
and a guided review (`GuideProofTests`: Pi sends `scripts/fixtures`' ledger
export guide through `submit_guide`; it opens from the thread, two sections
are marked reviewed and the Inbox keeps both ticks, read as the desktop window
reads them; a tick with the computer out of reach reads off again; Previous
and Next with the bar's title following; the wrap button; the largest Dynamic
Type size).
Every proof class ends by clearing the app's stored sources. The live sessions are the Claude Code mod's own code on real
processes (`apps/hook/hooks/mod/testing/claude-session.ts`), started by the
script in the projects the test writes to. Light and dark screenshots of each
screen and recordings land in `.local/proof/ios/`; `--only
PlannotatorUITests/DecisionsProofTests` runs one test. CI runs the same command
(`.github/workflows/ios.yml`).

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

The relay path (`RelayTransportTests`) runs the Inbox's Wi-Fi listener
(dialled at loopback, pinned), the tailnet's stand-in proxy and a proxy in
front of the relay that keeps what the phone posts: a wrong pin pairs nothing;
pairing by the QR's link goes over the Wi-Fi; 9.2 shows the Wi-Fi, then the
tailnet, then the relay in use as each one goes away; an agent's thread is
read, picked and sent through the relay and reaches `wait_for_reply`; the
pick's and the Send's commands posted again write nothing; a draft and a note survive a change
of path both ways; with the Inbox stopped a Send and a lock-screen answer wait
("Sent. Waiting for your computer") and reach the agents once it starts; a
held Send the computer refuses reads "Not sent" in plain words once the phone
is back on the tailnet; a push dressed as the extension leaves it makes the
app read again (the simulator never runs the extension); a
25 MiB store line draws "Too large to show here"; the relay switch off brings
nothing and says so. `--only PlannotatorUITests/RelayTransportTests` runs it
alone.

## Release and App Review

- `Plannotator/PrivacyInfo.xcprivacy`: the privacy manifest (no tracking, no
  collected data, `UserDefaults` for the app's own settings only). Each
  bundle whose code uses a required-reason API needs its own.
- `APP-REVIEW.md`: what App Review is told, and the privacy and export
  compliance answers.
- `RELEASE.md`: the release runbook the owner runs himself (the Apple account,
  the keys, the archive, the upload, TestFlight, the submission).

## The Workspaces source

The app reads Workspaces beside a computer's Inbox, one source at a time (the
title menu). `PlannotatorKit/WorkspacesClient.swift` speaks Workspaces' live
contract (`<origin>/v1/openapi.yaml`); `WorkspacesSource.swift` maps its doors
onto the Inbox's wire models (a comment thread is a thread, a notification row
is a list row), so the same list, thread, cards and reply bar draw both.
`SourceClient.swift` is the one protocol both sources fill.

- **Sign in** opens the sign-in door (`/auth/desktop/login`) in the system
  browser sheet (ephemeral, so nothing is shared with Safari). A signed build
  returns through `https://<origin>/auth/mobile/return/<nonce>`, which needs the
  associated domain (below) and the Team ID. The simulator has neither, so a simulator build returns through the
  door's loopback shape: a one-request listener on 127.0.0.1 hands the return
  to the sheet's `plannotator` scheme. Only a return carrying the sign-in's own
  `state` is redeemed. The session cookies live in the app's own cookie store;
  mutations echo the `csrf` cookie as `X-CSRF-Token`.
- **The build setting** `WORKSPACES_HOST` decides whether a build has the
  source at all. Debug and the TestFlight configuration name staging; Release,
  the App Store build, leaves it empty (the first App Store release is local
  only), so it has no Workspaces source and no associated domain. The host
  gives both the origin the app signs in to and the associated domain the
  `https` return needs (`Plannotator/Workspaces.entitlements`: `applinks:` and
  `webcredentials:` for that host). A TestFlight build is
  `xcodebuild archive -configuration TestFlight ...`; for production, set
  `WORKSPACES_HOST=workspaces.plannotator.ai`. The simulator ignores the
  entitlement; a signed build also needs the Team ID in the server's
  association file (owner item 1).

Its proof runs against staging with a test account (never a person's own) and
an API key of that account for the asking agent, locally only:

```bash
WORKSPACES_PROOF_EMAIL=... WORKSPACES_PROOF_PASSWORD=... WORKSPACES_PROOF_AGENT_KEY=... \
  bun apps/ios/scripts/workspaces-proof.ts --binary .local/plannotator
```

It pairs a real Inbox too (so the switcher has both), signs in through the real
AuthKit page, has the agent ask in a comment over MCP, picks, ticks a decision
and sends on the phone, reads the reply back with `list_annotations`, waits for
a row to arrive live, opens the document, and signs out (the session the app
held then answers 401). Without its variables the XCUITest skips itself, so CI
runs only the Inbox proof.

## Version

`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml`. The app is
private to this repo and stays out of the release-bumped files.
