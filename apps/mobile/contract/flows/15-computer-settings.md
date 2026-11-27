# 15. Looking after the computer from the phone (after v1)

**Not in the first version.** Decided 2026-11-18: managing the computer is left out of v1 and done later, as slice S9. This section is the design for then. These will live under the computer's entry in the switcher ("Work Mac", then its settings), drawn as native lists with the window's own section names and words. Nothing here asks an extra question; where the window itself asks first, the phone asks the same thing once in the same words.

| Section | What the person can do |
|---|---|
| Update | See the version and "Update to X"; Update now; the progress; "Restarting"; the failure screen with the log and Try again; Remind me tomorrow; Check now; Restart |
| Agents | Each kind of agent with its state; the Inbox tool switch per agent; the reminder words; connect-agent setup (the prompt and commands are copied or shared, since they are pasted on the computer); open sessions that need a restart; Start agents from New message; full permissions; where new agents start |
| Cloud agents | Pair one (kind, name, the one-time message with Copy and Share), live status, wake address, New pairing, Remove |
| Remote devices | The paired devices with platform, app version and last seen; Remove (asked twice, as in the window); the reach switches This Wi-Fi and Tailscale with their checks; Pair another device (this phone shows the code for the other one to scan); Cloudflare Access setup |
| Machines | Link a machine (paste a code, or an address and six digits), show this machine's link code, Unlink, Update a machine |
| Accounts | Each machine's Claude accounts and usage, the Codex account line, the Linear key |
| Capabilities | The switches for the Board, the Checklist, Routines, code review and the experimental group |
| Storage | Size per project and thread; delete a project's stored messages and files (asked twice, as in the window); Tidy; Combine with Undo |
| Projects | Rename, Reset name, Combine, picture |
| Voice | The computer's transcription engine and key (the phone's own dictation does not need it) |

Three things behave differently because the phone is far away, each said in one line where it happens and never as a question:

- **Restart and update**: the computer stops answering for some seconds. The switcher shows "Restarting Work Mac…" and the app reconnects by itself; if it has not come back after a minute the line says so and offers Try again through the relay.
- **Turning off the path the phone is using** (This Wi-Fi while on Wi-Fi, Tailscale while on the tailnet, the relay switch): it takes effect at once; the line under the switch says how the phone will reach the computer afterwards ("This phone will reach Work Mac through the relay only", or "This phone will not reach Work Mac away from home").
- **Removing this phone, or turning the phone door off**: the phone is disconnected. The row says "This disconnects this phone" beside the control. It is still one press (Remove asks twice because the window does).

## Checks

None yet. They are written with the slice that builds this flow.
