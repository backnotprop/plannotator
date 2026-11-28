# 2. First run and pairing

1. The app opens on the camera with "Scan the code on your computer" and one line saying where the code is (the Inbox, Settings, Remote devices, Pair a phone). The camera permission is asked here, with the reason.
2. The person scans the QR. The phone reads the pairing link (computer name, Wi-Fi address and certificate fingerprint, tailnet address, secret), redeems it at the computer and gets its token. The token and the secret go into the Keychain.
3. The app asks to send notifications ("So an agent's question reaches you"). Not allowed is fine; the app works without.
4. The list appears. First paint is the list read from the computer; there is no tour.

Other ways in, below the camera: the computers on this Wi-Fi, found by their Bonjour record (pairing with one still means scanning its QR: over the Wi-Fi the Inbox pairs by the QR's secret only, so the certificate fingerprint comes from the computer's screen, never from the network), and "Type the address and six digits" (tailnet only, as the window says).

When it fails: a wrong or expired code says so in the Inbox's words ("That code is not the one on your computer.", with the tries left; "This pairing code is no longer open. Make a new one on your computer."); a computer whose Plannotator is too old says "Update Plannotator on your computer" with the version it needs; a phone that cannot reach either address says which it tried and what each needs (the same Wi-Fi and Local Network allowed; Tailscale signed in).

Differs from the window: nothing. The window shows the code; the phone reads it. No account, no sign-in, no e-mail.

## Checks

- [pair-01] The app opens on the camera with "Scan the code on your computer" and one line saying where the code is. The camera permission is asked here, with the reason. phone differs: this screen is the phone's own; the window shows the code (phone only)
- [pair-02] Scanning the code redeems the pairing link at the computer (`POST pair`), which answers the device, its token and secret, the computer's name, its addresses and the relay. The token and the secret go into the Keychain. (packages/server/inbox-devices.ts:804; packages/server/inbox-devices.ts:848)
- [pair-03] After pairing, the app asks to send notifications. If the person does not allow them, the app still works. phone differs: a phone-only step, because the window asks for browser notifications on its own (phone only)
- [pair-04] The first screen after pairing is the list read from the computer. There is no tour. phone differs: the window's first run can show its tour; the app starts on the list (phone only)
- [pair-05] The app can list the computers on this Wi-Fi from their Bonjour record, but pairing over the Wi-Fi is by scanning the QR only: typed digits over the Wi-Fi are refused with "Over the Wi-Fi, pair by scanning the QR code on your computer's screen." (packages/server/inbox-lan.ts:10; packages/server/inbox-devices.ts:821)
- [pair-06] "Type the address and six digits" works over the tailnet only, as the window says ("Over Wi-Fi the phone pairs by scanning only."). (packages/inbox/components/PairFlow.tsx:406; packages/server/inbox-devices.ts:821)
- [pair-07] A wrong code says "That code is not the one on your computer." with the tries left (five per code); a closed or expired code says "This pairing code is no longer open. Make a new one on your computer." (packages/server/inbox-devices.ts:839; packages/server/inbox-devices.ts:825; packages/server/inbox-devices.ts:132)
- [pair-08] A computer whose Plannotator is too old says "Update Plannotator on your computer" with the version it needs. phone differs: the window never meets an older door; the app reads the door's contract version, which brief F1 adds (phone only)
- [pair-09] A phone that cannot reach either address says which address it tried and what each one needs. phone differs: the window's pairing screen lists what the phone needs per way (pairing.ts), the app says which one it tried (packages/inbox/components/PairFlow.tsx:243)
