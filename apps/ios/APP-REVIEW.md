# Plannotator for iPhone: notes for App Review

What the owner tells App Review, and the facts behind it. Section 3 holds the
notes text he pastes into App Store Connect (App Review Information, Notes);
the other sections back it and give his answers in the other App Store
Connect forms. The release runbook is `RELEASE.md`.

## 1. What the app is

Plannotator is a native client for the person's own Plannotator Inbox. The
Inbox runs on their computer, beside their coding agents (Claude Code, Codex,
OpenCode, Pi). Agents leave threads there: a message, questions with choices,
attached plans, pages and diagrams, guided reviews. The phone reads those
threads and sends the person's answers back to the same computer.

There are two builds:

- **The App Store build is local only.** It talks to one place: the Inbox on
  the person's own computer. It has no account, no sign-in and no server of
  ours holding readable data.
- **TestFlight builds** add a second source, Workspaces
  (`staging.workspaces.plannotator.ai`), with a sign-in. One build setting
  decides it (`WORKSPACES_ORIGIN`, section 4 of `RELEASE.md`); the App Store
  build leaves it empty and the Workspaces source does not appear.

The app reaches the computer in three ways, in this order: the same Wi-Fi, the
person's tailnet (Tailscale), and the Plannotator relay. The relay carries
only messages encrypted on the computer and the phone with keys made at
pairing; it cannot read them, and it deletes each one when the phone
acknowledges it. The relay also sends the push notification for a new
question, encrypted the same way.

Permissions the app asks for, and why:

- **Camera:** to scan the pairing code the computer shows.
- **Local Network:** to find and reach the person's computer on the same
  Wi-Fi.
- **Notifications:** to tell the person an agent asked a question. A question
  with a single choice can be answered from the notification after Face ID.

## 2. The web content inside the app (Guideline 2.5.2)

The screens that show an attachment (a plan, an HTML page, a diagram) and a
guided review use a `WKWebView`. The HTML, script and styles of that view are
the app's own code, built from Plannotator's open-source repository and
bundled in the app as `surface.html`. The app downloads no code and changes
no feature after review.

What an agent attaches (a Markdown file, an HTML page, a diagram) is content,
shown the way a browser shows a page:

- It is drawn in a sandboxed frame inside that bundled view, and it cannot
  send messages to the app.
- It has no network. Every response the app serves to the view carries a
  Content Security Policy with `connect-src 'none'`, and the view carries a
  content rule list that blocks every http, https, ws and wss load. If that
  rule list cannot be loaded, the view does not open at all.
- The app serves every byte itself, fetched from the person's own computer.
- A link in agent content opens only if it is `https` or `mailto`, and only
  in Safari View Controller or the system mail sheet.

## 3. How to review the app without your own computer

The app does nothing until it is paired with a Plannotator Inbox on a
computer. Pairing needs the computer's screen (a QR code) or a network path
to it (a tailnet address and a six-digit code). There is no demo mode inside
the app, and none is planned: a second way to fill the screens would be a
second app to keep correct.

What the owner provides with each submission:

- **A screen recording on an iPhone** (attached in App Review Information),
  showing: pairing by scanning the code; the Inbox list; a thread with an
  agent's questions; a pick and a typed note; Send, and the agent receiving
  the answer on the computer; an attached HTML page with a comment placed by
  touch; a guided review; a notification answered from the lock screen;
  Settings, including Remove this source.
- **Optional, if Review asks for a live session:** a demo Inbox on an
  always-on Mac, shared with the reviewer's device through a Tailscale node
  share, with the six digits sent in the notes. This needs the Tailscale app
  on the review device, so the recording comes first.

Notes text to paste (edit the bracketed parts):

> Plannotator is a companion to the Plannotator Inbox, which runs on the
> user's own computer next to their AI coding agents. The app pairs with that
> computer by scanning a QR code the computer shows, so it cannot be used
> without one. The attached recording shows the full flow on an iPhone:
> pairing, reading an agent's questions, answering and sending, commenting on
> an attached page, and answering from a notification. The web view inside
> the app shows the app's own bundled code; content from agents is displayed
> in a sandboxed frame with no network access. This build has no account and
> no sign-in. [If Review needs a live Inbox: contact (email) and we will share
> a demo computer over Tailscale.]

## 4. Account deletion (Guideline 5.1.1(v))

- **The App Store build has no account at all.** Pairing creates a device
  record on the person's own computer, never on a server of ours. Settings,
  Remove this source, revokes it on the computer and clears the phone; the
  computer's Inbox can also remove the phone. The relay holds only hashes, the
  push token and encrypted messages for a paired phone, and drops them when
  the phone is removed.
- **Builds with the Workspaces source can create an account.** Workspaces
  sign-in (AuthKit) offers Sign up, so the app must let a person delete their
  Workspaces account from inside the app. Workspaces has no account deletion
  yet: `DELETE /v1/me` is planned (W0, PR 974) and waits on the owner's
  ruling on personal credits and a team's sole admin (OWNER-ITEMS item 30).
  No build with the Workspaces source goes to external TestFlight testers or
  the App Store until that door and its Settings row ship. Internal
  TestFlight builds (the team's own testers) do not go through App Review.

## 5. Sign in with Apple (Guideline 4.8)

Only builds with the Workspaces source have a sign-in, and so only TestFlight
builds. The sign-in page is AuthKit's, opened in the system browser sheet.
That page already offers Apple beside Google, Microsoft and GitHub, so the app
adds no button of its own. On staging the Apple button runs on WorkOS's demo
credentials; a public build needs Plannotator's own Apple Services ID, key and
return URL in the production WorkOS environment (OWNER-ITEMS item 31). The
App Store build has no sign-in and nothing to answer here.

## 6. Export compliance

The app encrypts with Apple's CryptoKit only: AES-256-GCM, HKDF-SHA256 and
SHA-256 for the relay's end-to-end encryption, and the system's TLS for every
connection (URLSession and Network.framework, with a pinned certificate on the
Wi-Fi path). It implements no algorithm of its own.

App Store Connect's reference table ("Export compliance documentation for
encryption") lists "Your app uses encryption limited to that within the Apple
operating system" with "No documentation required". That is the row that
matches the code. The declaration is the owner's; `RELEASE.md` section 6 has the
answer and the optional Info.plist line that stops App Store Connect asking
on every upload.

## 7. Privacy

`Plannotator/PrivacyInfo.xcprivacy` is the privacy manifest:

- **Tracking:** none. No tracking domains, no third-party SDKs, no analytics.
- **Collected data:** none declared. Apple's definition of "collect" is data
  sent off the device and kept readable by the developer. The App Store build
  sends the person's content only to their own computer, directly or through
  the relay as ciphertext the relay cannot read and deletes on
  acknowledgment.
- **Required-reason APIs:** `UserDefaults` only, reason `CA92.1` (read and
  write information only the app itself can reach: the paired sources, the appearance, haptics
  and Send's idempotency keys). The code uses no file timestamp, system boot
  time, disk space or active keyboard API.

What the owner answers in App Privacy (App Store Connect):

- **App Store build:** "Data Not Collected", with one judgement that is his:
  the relay keeps each phone's APNs push token, readable, until the phone is
  removed or Apple answers 410. It is linked to no person or account. Apple's
  examples of "Device ID" name advertising identifiers; a push token used only
  to deliver the app's own notifications is usually not declared. If he
  prefers to declare it: Identifiers, Device ID, not linked, not tracking,
  App Functionality.
- **A public build with the Workspaces source** (not before production opens,
  OWNER-ITEMS item 9): Contact Info (Name, Email Address), Identifiers (User
  ID), User Content (Other User Content: comments and answers), and the push
  token, all linked to the person, App Functionality only. The manifest's
  `NSPrivacyCollectedDataTypes` gains the same entries in that release.

The app and the notification service extension (M5) share the App Group's
defaults (the two notification switches): the app's manifest carries reason
`1C8F.1` beside `CA92.1`, and the extension carries its own
`PlannotatorNotifications/PrivacyInfo.xcprivacy` with `1C8F.1`, because Apple
wants a manifest in every bundle whose executable uses a required-reason API.

## 8. Other App Store Connect answers

- **Privacy policy URL and support URL:** the owner's (OWNER-ITEMS item 7).
- **Age rating:** no objectionable content of the app's own; agent content is
  the person's own work, from their own computer.
- **Content rights:** the app shows only what the person's agents write.
