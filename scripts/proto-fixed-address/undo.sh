#!/usr/bin/env bash
# PROTOTYPE (proto/inbox-fixed-address): put this Mac back the way it was
# before try-on-this-mac.sh. Asks for your password (sudo) for the parts that
# need it, and verifies each one.
#
#   bash scripts/proto-fixed-address/undo.sh
#
# Works for either service this prototype installed: the plain-HTTP one
# (port 80, the current flow) or the earlier HTTPS one (443 + a CA). In order:
#   1. the alias removed and the scratch Inbox stopped (as you)
#   2. portless's own `clean` as root: its launchd service, the proxy, its
#      /etc/hosts block, ~/.portless (and the CA's trust, when there is one)
#   3. belt and braces for anything `clean` left: the same pieces by hand.
#      A CA is removed from the keychains only by the SHA-1 fingerprint of the
#      one this recipe's earlier HTTPS try made (recorded by try-on-this-mac.sh,
#      or read from ~/.portless/ca.pem now); no other certificate is touched.
#   4. the scratch folder removed
#   5. verified: no service, nothing of portless on 80 or 443, no ~/.portless,
#      no /etc/hosts block, our CA in no keychain, real Inbox unchanged
# It refuses to run when try-on-this-mac.sh did not make the scratch folder,
# because step 2 removes portless wholesale (try refuses to start on a Mac
# where portless was set up before, so everything portless here is ours).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
PASSES=0
FAILS=0

[ -f "$SCRATCH/made-by-try" ] || { echo "No scratch folder from try-on-this-mac.sh at $SCRATCH; nothing of this recipe to undo." >&2; exit 2; }

NODE="$(node -e 'process.stdout.write(require("fs").realpathSync(process.execPath))' 2>/dev/null || true)"
CLI="$DATA/portless/node_modules/portless/dist/cli.js"

# The CA the earlier HTTPS try made, by fingerprint, read before `clean` removes ~/.portless.
CA_SHA1="$(cat "$CA_RECORD" 2>/dev/null || true)"
if [ -z "$CA_SHA1" ] && [ -f "$PORTLESS_STATE/ca.pem" ]; then
  CA_SHA1="$(openssl x509 -in "$PORTLESS_STATE/ca.pem" -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g')"
fi
CA_COPY="$SCRATCH/portless-ca.pem"
[ -f "$PORTLESS_STATE/ca.pem" ] && cp "$PORTLESS_STATE/ca.pem" "$CA_COPY" 2>/dev/null
ca_in() { security find-certificate -a -Z "$1" 2>/dev/null | grep -qi "SHA-1 hash: $CA_SHA1"; }

say "1. The alias, then the scratch Inbox"
if curl -s --max-time 2 "http://127.0.0.1:$(scratch_port)/api/inbox/health" >/dev/null 2>&1; then
  pn inbox --name off >/dev/null 2>&1 && echo "  alias removed (inbox.plannotator)" || echo "  (could not turn it off through the Inbox; clean below removes routes anyway)"
  stop_scratch_inbox
fi
echo "  scratch Inbox stopped"

say "2. portless clean (as root; sudo asks for your password)"
if [ -n "$NODE" ] && [ -f "$CLI" ]; then
  sudo /usr/bin/env SUDO_USER="$(id -un)" SUDO_UID="$(id -u)" SUDO_GID="$(id -g)" HOME="$HOME" PORTLESS_STATE_DIR="$PORTLESS_STATE" \
    "$NODE" "$CLI" clean || echo "  portless clean reported a problem; step 3 removes the pieces by hand"
else
  echo "  portless is not in the scratch folder any more; step 3 removes the pieces by hand"
fi

say "3. Anything left, by hand"
if [ -e "$PORTLESS_PLIST" ]; then
  sudo launchctl bootout system "$PORTLESS_PLIST" 2>/dev/null || true
  sudo rm -f "$PORTLESS_PLIST"
  echo "  removed $PORTLESS_PLIST"
fi
if [ -n "$CA_SHA1" ]; then
  if [ -f "$CA_COPY" ]; then
    sudo security remove-trusted-cert -d "$CA_COPY" 2>/dev/null || true
    security remove-trusted-cert "$CA_COPY" 2>/dev/null || true
  fi
  for _ in $(seq 1 5); do ca_in /Library/Keychains/System.keychain || break; sudo security delete-certificate -Z "$CA_SHA1" /Library/Keychains/System.keychain >/dev/null 2>&1 || break; done
  for _ in $(seq 1 5); do ca_in "$HOME/Library/Keychains/login.keychain-db" || break; security delete-certificate -Z "$CA_SHA1" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1 || break; done
  echo "  the earlier try's CA ($CA_SHA1) removed from the keychains where it was"
else
  echo "  no CA was made (the plain-HTTP flow makes none)"
fi
if grep -q '# portless-start' /etc/hosts 2>/dev/null; then
  sudo sed -i '' '/# portless-start/,/# portless-end/d' /etc/hosts
  echo "  removed the portless block from /etc/hosts"
fi
if [ -e "$PORTLESS_STATE" ]; then
  sudo rm -rf "$PORTLESS_STATE"
  echo "  removed $PORTLESS_STATE"
fi

say "4. The scratch folder"
REAL_BEFORE="$(cat "$SCRATCH/real-inbox-session.before" 2>/dev/null)"
rm -rf "$SCRATCH"
echo "  removed $SCRATCH"

say "5. Verify"
[ ! -e "$PORTLESS_PLIST" ] && ok "no launchd service file" || bad "$PORTLESS_PLIST still exists"
sudo launchctl print system/sh.portless.proxy >/dev/null 2>&1 && bad "launchd still knows sh.portless.proxy" || ok "launchd has no sh.portless.proxy"
if [ -n "$CA_SHA1" ]; then
  ca_in /Library/Keychains/System.keychain && bad "our CA is still in the System keychain" || ok "our CA is not in the System keychain"
  ca_in "$HOME/Library/Keychains/login.keychain-db" && bad "our CA is still in the login keychain" || ok "our CA is not in the login keychain"
fi
portless_on 80 && bad "something still answers on 80 as portless" || ok "nothing answers on 80 as portless"
portless_on 443 && bad "something still answers on 443 as portless" || ok "nothing answers on 443 as portless"
[ ! -e "$PORTLESS_STATE" ] && ok "no ~/.portless" || bad "$PORTLESS_STATE still exists"
grep -q '# portless-start' /etc/hosts 2>/dev/null && bad "/etc/hosts still has a portless block" || ok "/etc/hosts has no portless block"
NOW="$(real_inbox_session || true)"
[ "$REAL_BEFORE" = "$NOW" ] && ok "real Inbox on :$REAL_INBOX_PORT unchanged (${NOW:-not running})" || bad "real Inbox changed: before '${REAL_BEFORE:-none}', now '${NOW:-none}'"
if command -v tailscale >/dev/null; then tailscale serve status >/dev/null 2>&1 && ok "tailscale serve still answers its status" || note "tailscale not running"; fi

say "Undo: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
