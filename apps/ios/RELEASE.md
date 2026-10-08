# Plannotator for iPhone: the release runbook

The owner runs every step here himself: each one needs his Apple account, a
key Apple shows once, or his declaration. No session signs in to his Apple
account, holds a key or a certificate, uploads a build or submits one. The
review notes and the privacy answers are in `APP-REVIEW.md`.

Placeholders: `<TEAM_ID>` is the Apple Developer Team ID (step 1). Commands run
from the repository root on his Mac, Xcode 26 selected
(`xcode-select -p` prints `/Applications/Xcode.app/Contents/Developer`).

## Before the first upload

All of the app's steps (M1 to M7) are on `main`, and the iPhone app workflow
(`.github/workflows/ios.yml`) is green on it. A build that signs in to
Workspaces on a device also needs the app's associated-domains entitlement
(`applinks:` and `webcredentials:` for `staging.workspaces.plannotator.ai`) on
`main`; without it the sign-in sheet cannot return to the app.

## 1. Account and identifiers (once)

1. Membership: developer.apple.com, Account, Membership details: the membership is active; note the Team ID there as `<TEAM_ID>`.
2. Xcode: Settings, Accounts, +, Apple Account: sign in; the team appears with its Team ID.
3. Repository: `bun install --frozen-lockfile` (the archive's "Bundle the surface" phase runs `bun run --cwd apps/inbox build:surface`).
4. Give the overseer `<TEAM_ID>` for the Workspaces association file: it replaces the `TEAMIDTODO` value of `APPLE_TEAM_ID` in `apps/rooms/wrangler.api.jsonc` (staging) of the Workspaces repo. It is a plain var, not a secret: Apple publishes the Team ID in every association file and every signed app.
5. Check, after that deploy: `curl -s https://staging.workspaces.plannotator.ai/.well-known/apple-app-site-association` names `<TEAM_ID>.ai.plannotator.app` under `applinks` and `webcredentials`.

## 2. Push keys (once)

1. developer.apple.com, Certificates, Identifiers & Profiles, Keys, +: name "Plannotator relay", tick Apple Push Notification service (APNs), Configure: environment Sandbox & Production, Continue, Register, Download (Apple offers the `.p8` once); note the Key ID.
2. The same again named "Plannotator Workspaces", so either can be revoked alone. If Apple refuses a second key, use the first key in both places.
3. Relay, from `apps/relay`: `wrangler secret put APNS_KEY` (paste the relay key's `.p8` text), `wrangler secret put APNS_KEY_ID`, `wrangler secret put APNS_TEAM_ID` (`<TEAM_ID>`), then `wrangler deploy` (`apps/relay/README.md`, Deploy).
4. Workspaces, from `apps/rooms` in the Workspaces repo: `wrangler secret put APNS_KEY --config wrangler.api.jsonc --env staging`, then the same for `APNS_KEY_ID` and `APNS_TEAM_ID`.
5. Delete both `.p8` files, or keep them in a password manager; never in a repository, a chat or a note.

TestFlight and App Store builds are signed for distribution, so their push
tokens are production tokens; the app registers them as `production` and both
senders pick Apple's host from that.

## 3. The App Store Connect record (once)

1. Register the identifiers by archiving once (step 4.1 with `-allowProvisioningUpdates`): automatic signing creates the App IDs `ai.plannotator.app` and `ai.plannotator.app.notifications`, the App Group `group.ai.plannotator.app`, the Push Notifications and Associated Domains capabilities, the distribution certificate and the profiles. If Xcode reports a capability it cannot add, add it at developer.apple.com, Identifiers, `ai.plannotator.app`.
2. App Store Connect, Apps, +, New App: platform iOS, name Plannotator, primary language English (U.S.), bundle ID `ai.plannotator.app`, SKU `plannotator-ios`, user access Full Access.
3. App Store Connect, Apps, Plannotator, TestFlight, Internal Testing, +: group "Team", add the testers (people on the App Store Connect team), turn on automatic distribution.

## 4. A TestFlight build (Workspaces source on, internal testers only)

The Workspaces source is decided by one build setting, `WORKSPACES_HOST`
(M7, `project.yml`): Debug and the TestFlight configuration name staging, and
carry the associated domain the sign-in return needs
(`Plannotator/Workspaces.entitlements`); Release, the App Store build, leaves
it empty. This archive uses the TestFlight configuration. Exported with `testFlightInternalTestingOnly`, App Store
Connect refuses to offer the build to external testers or the App Store, which
holds the Workspaces build back until account deletion ships (`APP-REVIEW.md`
section 4).

1. Archive: `xcodebuild archive -project apps/ios/Plannotator.xcodeproj -scheme Plannotator -configuration TestFlight -destination 'generic/platform=iOS' -archivePath /tmp/plannotator-ios/testflight.xcarchive DEVELOPMENT_TEAM=<TEAM_ID> -allowProvisioningUpdates`
2. Check the source is on: `/usr/libexec/PlistBuddy -c 'Print :WorkspacesOrigin' /tmp/plannotator-ios/testflight.xcarchive/Products/Applications/Plannotator.app/Info.plist` prints the staging origin, and `codesign -d --entitlements - /tmp/plannotator-ios/testflight.xcarchive/Products/Applications/Plannotator.app` lists `applinks:` and `webcredentials:` for `staging.workspaces.plannotator.ai`.
3. Export options, once:

   ```sh
   cat > /tmp/plannotator-ios/testflight-export.plist <<'PLIST'
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>method</key><string>app-store-connect</string>
     <key>destination</key><string>upload</string>
     <key>signingStyle</key><string>automatic</string>
     <key>testFlightInternalTestingOnly</key><true/>
   </dict></plist>
   PLIST
   ```

4. Upload: `xcodebuild -exportArchive -archivePath /tmp/plannotator-ios/testflight.xcarchive -exportOptionsPlist /tmp/plannotator-ios/testflight-export.plist -exportPath /tmp/plannotator-ios/testflight-export -allowProvisioningUpdates` (Xcode sets the next build number on upload). The same from the window: Xcode, Window, Organizer, Archives, the archive, Distribute App, TestFlight Internal Only.
5. App Store Connect, Apps, Plannotator, TestFlight: the build finishes processing; answer the export compliance question (step 6) if asked; the Team group receives it.

## 5. The App Store build (local only)

1. Archive without the Workspaces source: `xcodebuild archive -project apps/ios/Plannotator.xcodeproj -scheme Plannotator -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/plannotator-ios/appstore.xcarchive DEVELOPMENT_TEAM=<TEAM_ID> -allowProvisioningUpdates`
2. Check the source is off: the same `PlistBuddy` line on `appstore.xcarchive` prints an empty line.
3. Privacy report: Xcode, Window, Organizer, Archives, Control-click the archive, Generate Privacy Report: it lists no collected data and no tracking.
4. Export options: the plist of step 4.3 without the `testFlightInternalTestingOnly` line, saved as `/tmp/plannotator-ios/appstore-export.plist`.
5. Upload: `xcodebuild -exportArchive -archivePath /tmp/plannotator-ios/appstore.xcarchive -exportOptionsPlist /tmp/plannotator-ios/appstore-export.plist -exportPath /tmp/plannotator-ios/appstore-export -allowProvisioningUpdates`
6. Before submitting, try it from TestFlight on a real iPhone: pair by scanning, answer a question, answer one from the lock screen; Settings shows no Workspaces row.

## 6. Export compliance (each build until the Info.plist answers it)

1. App Store Connect asks on the first build: the app uses encryption, limited to that within the Apple operating system (CryptoKit and the system's TLS; `APP-REVIEW.md` section 6). That row of Apple's table needs no documentation. The declaration is his.
2. Optional, to stop the question on every upload: ask for the one-line PR that adds `ITSAppUsesNonExemptEncryption: false` under the app's `info.properties` in `project.yml` (and `xcodegen generate`).

## 7. The listing and the submission

1. App Store Connect, Apps, Plannotator, App Information: privacy policy URL, category (Developer Tools fits), content rights, age rating questionnaire.
2. App Privacy: the answers in `APP-REVIEW.md` section 7 for the App Store build.
3. Pricing and Availability: Free; the countries he chooses.
4. The 1.0 version page: screenshots (6.9-inch iPhone, light), description, keywords, support URL, the build from step 5.
5. App Review Information: no sign-in required; the notes text from `APP-REVIEW.md` section 3; attach the screen recording; his contact details.
6. Version Release: manually release this version.
7. Add for Review, then Submit to App Review.
8. Approved: Release This Version when he chooses.

## If something leaks

- An APNs key: developer.apple.com, Keys, the key, Revoke; make a new one (step 2.1) and put it back with step 2.3 or 2.4. The other key keeps working.
- The distribution certificate: developer.apple.com, Certificates, Revoke; the next archive with `-allowProvisioningUpdates` makes a new one. Installed apps keep working.
