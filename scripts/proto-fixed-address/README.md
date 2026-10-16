# PROTOTYPE: a fixed address for the Inbox (portless, plain HTTP)

Branch `proto/inbox-fixed-address`. Not for merge. Research: `.product/drafts/portless-local-url/` (BRIEF.md, one-click/README.md).

The flow under test: the Inbox shows a one-time dialog, "Give the Inbox a fixed address: inbox.plannotator.localhost", with Sure and Not now. Sure triggers the OS password prompt once. From then on the Inbox is at `http://inbox.plannotator.localhost`, and that address stays the same when the Inbox's port changes.

Plain HTTP on purpose. The proxy answers this computer only, and `http://*.localhost` is a secure context in Chromium, Firefox and WebKit, so notifications work. There is no certificate to make, trust or warn about: `portless service install --no-tls` never touches portless's CA (its `installService` calls `prepareTrust` only for HTTPS).

## Where the code is

| Piece | File |
|---|---|
| Name listener, request check, port-80 check, portless adapter, privileged command builders | `packages/server/inbox-name.ts` |
| Routes `GET/POST /api/inbox/name`, `POST /api/inbox/name/dialog`, control route `/api/inbox/control/name` | `packages/server/inbox.ts` |
| Hidden `plannotator inbox --name on\|off\|status` | `apps/hook/server/inbox-command.ts` |
| Dialog (third in the chain, after sound and agent note) and Settings → Devices row | `packages/inbox/components/FixedAddress.tsx`, `App.tsx`, `Settings.tsx` |
| Unit and route tests (scripted runner; nothing real runs) | `packages/server/inbox-name.test.ts` |

The prototype is inert unless the Inbox starts with `PLANNOTATOR_PROTO_FIXED_ADDRESS=1`. Without it, nothing looks up Node, opens a listener, spawns a process, or draws the row.

## What Sure does

1. Finds Node 24+ (portless needs it). Without it the offer never shows.
2. Looks at port 80. Another program there: it stops and says which ("Port 80 is already used by another program … it answered as "nginx""), with no prompt and nothing installed. A portless HTTPS proxy that Plannotator did not install: left alone, same message style.
3. Installs portless 0.15.8 into the data folder, as the person.
4. The one privileged step, only when a plain-HTTP portless is not already on 80: `portless service install --no-tls --port 80` (on macOS behind the launchctl shim, after the marker; see "The wait after the password"). When this prototype's own earlier HTTPS service is installed (read from `/Library/LaunchDaemons/sh.portless.proxy.plist`, matched by our `cli.js` path), the same elevated command runs `service uninstall ; service install --no-tls …`, so it is still one prompt.
5. `portless alias inbox.plannotator <name listener port>`, as the person.
6. Verifies `http://inbox.plannotator.localhost/api/inbox/health` answers this Inbox's `serverSession` (falls back to `127.0.0.1:80` with the name as Host when the process cannot resolve the name).

## The wait after the password (measured 2026-10-16)

The owner's first run, read from file times on his Mac (nothing re-run with admin):

| Time | What |
|---|---|
| 15:28:39.6 | npm install of portless ends (it takes 0.13 to 0.4 s; measured into a temp prefix, warm and cold cache) |
| 15:28:42 | the launchd plist is written: the password went in about 2 s after the prompt |
| 15:28:52 | the proxy writes its pid: **10 s later** |
| 15:28:52.9 | the elevated command (osascript) returns |
| 15:28:53.5 | `portless alias` ends (0.6 s) |
| 15:28:54 | verified, `name.json` written; the window then took up to 1 s (its poll) plus 0.9 s (a fixed pause) to move the tab |

The 10 s is launchd. portless's macOS install runs `launchctl bootstrap` (RunAtLoad starts the proxy at once) and then `launchctl kickstart -k`, which kills that new instance; launchd then holds the respawn for its ThrottleInterval (10 s), and `kickstart` blocks until then. A temp LaunchAgent reproduces it as the person: `kickstart -k` right after `bootstrap` takes 10.02 s; plain `kickstart` takes 0.007 s; portless's whole launchctl sequence through the shim below takes 0.18 s. The proxy itself is listening 75 ms after it starts (`proxy start --foreground` on a high port).

What changed:

- The elevated macOS command puts a `launchctl` shim first on PATH (a root-owned `mktemp -d` folder under /tmp, made and removed inside the same command) that turns `kickstart -k` into `kickstart`. Everything else passes through to /bin/launchctl. Expected wait after the password: about 1 s instead of 11.
- The elevated command's first act makes a marker folder (`<data dir>/inbox/name-setup/accepted-<random>`, the folder made by the person before the prompt; on Windows the person's PowerShell makes it once UAC returns). The server looks for it every 250 ms and moves `step` from `password` to `installing`, then `starting` (proxy and alias) and `verifying`. The window never says "waiting for your password" after it was typed.
- portless is fetched when the dialog is shown (`prefetch`), so Sure goes straight to the prompt.
- The server's waits poll every 250 ms (was 500); the window reads the state every 250 ms while setup runs (was 1 s) and moves the tab 0.4 s after "Done" (was 0.9 s).
- Each logged command now says how long it took (`… -> exit 0 in 812 ms`), plus lines for the password, the proxy and the verify.

## On the owner's Mac

```sh
bash scripts/proto-fixed-address/try-on-this-mac.sh   # builds, starts a SCRATCH Inbox, opens it
# click Sure in the dialog; type your password once ("osascript wants to make changes")
bash scripts/proto-fixed-address/checklist.sh         # verifies; asks you two y/n questions
bash scripts/proto-fixed-address/undo.sh              # puts the Mac back (sudo asks for the password)
```

The scratch Inbox uses `$TMPDIR/plannotator-proto-fixed-address/data`. It never uses `~/.plannotator` or the real Inbox on port 59812. The try script refuses to run if portless was set up on the Mac before this recipe, because the undo removes portless completely. If the earlier HTTPS try is still installed, Sure replaces it in the same single prompt, and undo removes its leftover CA from the keychains by its SHA-1 fingerprint only.

## Windows and Linux

### CI (everything except the password prompt)

`gh workflow run 385915726 --ref proto/inbox-fixed-address` runs `ci-check.ts` on ubuntu-latest, windows-latest and macos-latest. The runners are already admin, so the privileged step runs as `sudo -n` (`PLANNOTATOR_PROTO_NAME_ELEVATE=sudo`) or directly in the elevated Windows session (`=direct`). The steps:

- Click Sure in headless Chromium; exactly one privileged command, and it is `--no-tls`.
- The tab moves itself to the name.
- The name answers this Inbox over plain HTTP; no CA was made; nothing of portless on 443.
- A browser loads the name as a secure context with the Notification API.
- Move the Inbox to a new port and check that the name follows with no privileged step.
- Turn the address off.

Results go to the job summary. Screenshots are uploaded as artifacts.

### What still needs a person, and how to do it in a VM

| OS | Prompt that CI cannot click | What to check by hand |
|---|---|---|
| Windows 11 | UAC ("Do you want to allow this app to make changes?" for `node.exe`, "Publisher: Unknown" until signed). With plain HTTP there is no certificate dialog after it. | One prompt. After Sure, Edge and Chrome open the name. A port change keeps the name. |
| Ubuntu desktop | The polkit dialog from `pkexec`. It names the binary path, not our reason (`/bin/sh` when replacing an earlier service). | One prompt. Chromium and Firefox open the name. |

**Windows 11 ARM in UTM or Parallels on this Mac:**

1. Install Git for Windows, Bun (`powershell -c "irm bun.sh/install.ps1|iex"`) and Node 24 (nodejs.org MSI).
2. Clone the repo and check out `proto/inbox-fixed-address`.
3. Run `bun install`, then `bun run build:review && bun run build:hook`.
4. In a NON-elevated Git Bash, start the scratch Inbox:

   ```sh
   export PLANNOTATOR_DATA_DIR="$TEMP/pn-fixed" PLANNOTATOR_INBOX_CONNECT=0 PLANNOTATOR_INBOX_NOTES=0 PLANNOTATOR_PROTO_FIXED_ADDRESS=1
   bun apps/hook/server/index.ts inbox --background
   ```

5. Open the printed URL and click Sure. Accept UAC.
6. Run `bun scripts/proto-fixed-address/browser-check.ts <serverSession>`.
7. Test a port change: stop the Inbox, hold its old port, and start it again. `ci-check.ts` step 5 shows how.
8. Undo, in an elevated shell: `node "$PLANNOTATOR_DATA_DIR/portless/node_modules/portless/dist/cli.js" clean`.

**Ubuntu 24.04 desktop VM:** follow the same steps, then click Sure and authenticate in the polkit dialog. Undo with `sudo env HOME=$HOME PORTLESS_STATE_DIR=$HOME/.portless node <cli.js> clean`.

## Safari and name resolution (checked 2026-10-16 on this Mac)

- macOS 26.3's system resolver maps any `*.localhost` name to loopback with no `/etc/hosts` line: `dscacheutil -q host -a name zzzq-test.localhost` answers `127.0.0.1` and `::1`, and so do Node's `dns.lookup` and `Bun.dns.lookup`.
- Headless Playwright WebKit 26.6 (Safari 26's engine), Chromium 153 and Firefox 155 all load `http://zzq-sc-probe.localhost:<port>/` (a name in no hosts file) and `http://inbox.plannotator.localhost:<port>/` with `isSecureContext === true` and a Notification API. Real Safari was not driven (no OS-level automation on the owner's screen).
- portless's root proxy also keeps `127.0.0.1 inbox.plannotator.localhost` in `/etc/hosts` (its default `PORTLESS_SYNC_HOSTS`, which the flow sets explicitly). That covers Safari on a resolver that does not map `*.localhost` itself, inside the same single prompt: the service runs as root.

## Open risks (what this prototype exists to find out)

- **Port 80 taken.** Another web server (a Docker container, nginx, Apache from Homebrew, another dev proxy) on port 80 stops the flow before anything is installed or asked, with a plain message naming what answered. If the port is taken after the prompt (a race), the proxy cannot start; the flow reads portless's `service.log` and says `EADDRINUSE` means port 80 is in use. Root-owned listeners are invisible to an unprivileged `lsof`, so the message can only name what answered over HTTP.
- **Windows: http.sys on port 80.** The windows-latest runner image has port 80 held by `System` (PID 4, http.sys, for IIS's W3SVC/WAS); Sure refused there with the plain message and no prompt. CI stops W3SVC/WAS first to run the rest. A person's Windows PC normally has nothing on 80, but one with IIS, or another program that registered an http.sys URL on 80, gets the same refusal.
- **Someone else's portless.** An HTTPS portless the person set up themselves is left alone (the flow refuses rather than replace it). A plain-HTTP portless already on 80 is reused with no prompt. On Windows the flow does not read the scheduled task, so an earlier HTTPS install of this prototype there reads as someone else's: run portless's `clean` first (VM steps below).
- **The service pins a Node path.** The plist names the real path of the Node the Inbox found. If that Node version is uninstalled (fnm, nvm), the proxy stops at the next boot. It also names `cli.js` under the data folder.
- **Node 24 is required** (portless 0.15.8's floor). Without it the offer never shows.
- **portless is pre-1.0.** We pin 0.15.8 and install it with npm from the registry at click time, which needs network.
- No longer applies: the CA trust prompts (macOS keychain, Windows certificate dialog, Linux NSS) and the Tailscale-on-443 conflict. Nothing of this flow uses 443.

## What CI found with HTTPS (2026-10-15, before the switch to plain HTTP)

- Linux and macOS: the routing worked; CA trust needed NSS by hand (Linux) and could not be added without a person (macOS; on the owner's Mac too, so Chrome showed NET::ERR_CERT_AUTHORITY_INVALID).
- Windows: trusting the CA showed Windows' own Security Warning dialog, a second prompt after UAC.
- The proxy took over 15 s to come up after `launchctl` on a CI Mac; the flow waits up to 90 s. (10 s of that was launchd's respawn throttle after `kickstart -k`; the shim removes it.)
- Playwright under Bun on Windows never launches Chromium, so CI drives the browser with Node.
