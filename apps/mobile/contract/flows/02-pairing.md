# 2. First run and pairing

1. The app opens on the camera with "Scan the code on your computer" and one line saying where the code is (the Inbox, Settings, Remote devices, Pair a phone). The camera permission is asked here, with the reason.
2. The person scans the QR. The phone reads the pairing link (computer name, Wi-Fi address and certificate fingerprint, tailnet address, secret), redeems it at the computer and gets its token. The token and the secret go into the Keychain.
3. The app asks to send notifications ("So an agent's question reaches you"). Not allowed is fine; the app works without.
4. The list appears. First paint is the list read from the computer; there is no tour.

Other ways in, below the camera: "Find it on this Wi-Fi" (lists computers with an open pairing offer, then asks for nothing more) and "Type the address and six digits" (tailnet only, as the window says).

When it fails: wrong or expired code says so with "Show a new code on your computer"; a computer whose Plannotator is too old says "Update Plannotator on your computer" with the version it needs; a phone that cannot reach either address says which it tried and what each needs (the same Wi-Fi and Local Network allowed; Tailscale signed in).

Differs from the window: nothing. The window shows the code; the phone reads it. No account, no sign-in, no e-mail.

## Checks

- [pair-01] The app opens on the camera with "Scan the code on your computer" and one line saying where the code is. The camera permission is asked here, with the reason.
- [pair-02] Scanning the code redeems the pairing link at the computer. The token and the secret go into the Keychain.
- [pair-03] After pairing, the app asks to send notifications. If the person does not allow them, the app still works.
- [pair-04] The first screen after pairing is the list read from the computer. There is no tour.
- [pair-05] "Find it on this Wi-Fi" lists computers with an open pairing offer and asks for nothing more.
- [pair-06] "Type the address and six digits" works over the tailnet only, as the window says.
- [pair-07] A wrong or expired code says so, with "Show a new code on your computer".
- [pair-08] A computer whose Plannotator is too old says "Update Plannotator on your computer" with the version it needs.
- [pair-09] A phone that cannot reach either address says which address it tried and what each one needs.
