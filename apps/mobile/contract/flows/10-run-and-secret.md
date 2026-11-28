# 10. A command to run and a secret to give

Both are in flight in the product (not merged on 2026-11-18); the phone follows the Inbox's card.

**A command.** The card shows its title, why, the exact command, the folder, the computer, and which saved secrets it will use. **Run** starts it on the computer that owns the thread. The card then shows the output as it arrives (the last lines, secret values hidden as dots), a Stop button, and how it ended ("Ran · 4 s", "Stopped", "Failed to start"). The result goes to the agent by itself. The phone sends the command's bytes with the press; the computer runs its own stored copy only when they match, so a stale card is refused with "This command changed. Read it again."

A run is never held while the computer is asleep. The button then reads "Work Mac is asleep" and does nothing; a command must not run minutes later, when the person is no longer looking.

**A secret.** The card names the secret, why it is wanted and where it goes. The field is the system's secure field (no predictive text, no keyboard learning, hidden in the app switcher). Paste or type, Save. The value is sealed for the computer, sent at once or not at all, never written to the phone's disk, never put in a held write. Afterwards the card says "Saved on Work Mac" and offers Remove.

No extra confirm: Run, a secret, Start and Stop are one press, as in the window (owner ruling 2026-11-18: no barriers unless they prevent a real fault). The phone's own lock is the protection.

## Checks

None yet. They are written with the slice that builds this flow.
