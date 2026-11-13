#!/usr/bin/env bash
set -u
RELAY="${1:-https://relay.plannotator.ai}"
HOST="${RELAY#https://}"
failed=0
pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1"; failed=1; }
invalid_create() { curl -sS -o /dev/null -w '%{http_code}' -X POST "$RELAY/v1/mailboxes" -H 'Content-Type: application/json' --data '{"secret_sha256":"not-a-hash"}'; }

body=$(curl -sS -w ' %{http_code}' "$RELAY/v1/nothing")
[ "$body" = '{"error":"not found","code":"not_found"} 404' ] && pass "unknown route: 404 not_found" || fail "unknown route answered: $body"

body=$(curl -sS -w ' %{http_code}' -X POST "$RELAY/v1/mailboxes" -H 'Content-Type: application/json' --data '{"secret_sha256":"not-a-hash"}')
case "$body" in *'"code":"bad_request"} 400' | *'"code":"too_many_requests"} 429') pass "invalid create: 400 bad_request (or 429), nothing made" ;; *) fail "invalid create answered: $body" ;; esac

answer=$(curl -sS -D - -o /tmp/relay-live-check-body.$$ "http://$HOST/v1/mailboxes/probe-path-echo" | tr -d '\r')
status=$(printf '%s' "$answer" | head -1 | awk '{print $2}')
location=$(printf '%s' "$answer" | awk -F': ' 'tolower($1)=="location"{print $2}')
if [ "$status" = 403 ] && [ ! -s /tmp/relay-live-check-body.$$ ]; then pass "plain http: bare 403 from the Worker"
elif [ "$status" = 301 ] && [ "${location#https://}" != "$location" ]; then pass "plain http: 301 to https (zone's Always Use HTTPS)"
else fail "plain http answered $status (location: ${location:-none})"; fi
rm -f /tmp/relay-live-check-body.$$

mbx="mbx_$(head -c 16 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
dev="dev_$(head -c 20 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 26 | tr 'a-f' 'A-F')"
for path in socket "devices/$dev/items"; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong-token' "$RELAY/v1/mailboxes/$mbx/$path")
  case "$status" in 401 | 404) pass "wrong token on ${path%%/*}: $status" ;; *) fail "wrong token on ${path%%/*} answered $status" ;; esac
done

statuses=""
for _ in $(seq 1 25); do statuses="$statuses $(invalid_create)"; done
echo "      25 invalid creates:$statuses"
case "$statuses" in *201*) fail "a create succeeded" ;; esac
case "$statuses" in *5[0-9][0-9]*) fail "the brake answered 5xx" ;; esac
case "$statuses" in *429*) pass "the brake answers 429 within 25 creates a minute" ;; *) fail "no 429 in 25 creates" ;; esac
retry=$(curl -sS -o /dev/null -D - -X POST "$RELAY/v1/mailboxes" --data '{}' | tr -d '\r' | awk -F': ' 'tolower($1)=="retry-after"{print $2}')
case "$retry" in [1-9] | [1-5][0-9] | 60) pass "429 carries Retry-After: $retry" ;; *) fail "Retry-After was '${retry:-absent}'" ;; esac

exit $failed
