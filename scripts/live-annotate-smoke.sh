#!/usr/bin/env bash
# Manual smoke test for live local app annotation (phase 1). NOT run in CI.
#
# Scaffolds a Vite React app in a temp dir, starts its dev server, opens a
# live annotate session against it through the local plannotator checkout,
# and prints the human checklist that constitutes the phase 1 exit bar.
#
# Prereqs: bun, and `bun link` run once in this checkout so the global
# `plannotator` command uses apps/hook/server/index.ts.

set -euo pipefail

VITE_PORT="${VITE_PORT:-5173}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/plannotator-live-smoke.XXXXXX")"

cleanup() {
  if [[ -n "${VITE_PID:-}" ]]; then
    kill "$VITE_PID" 2>/dev/null || true
  fi
  echo
  echo "Scaffolded app left at: $WORKDIR (delete when done)"
}
trap cleanup EXIT

echo "==> Scaffolding a Vite React app in $WORKDIR"
cd "$WORKDIR"
bunx create-vite live-smoke --template react-ts >/dev/null
cd live-smoke
bun install >/dev/null

echo "==> Starting vite dev on port $VITE_PORT"
bun run dev -- --port "$VITE_PORT" --strictPort &
VITE_PID=$!

echo "==> Waiting for the dev server"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://localhost:$VITE_PORT"; then
    break
  fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "http://localhost:$VITE_PORT"; then
  echo "vite dev server did not come up on port $VITE_PORT" >&2
  exit 1
fi

cat <<'CHECKLIST'

============================================================
LIVE ANNOTATE SMOKE CHECKLIST (Vite React)
============================================================
The annotate session opens next. Work through, in order:

 1. Pinpoint: click an element in the app (e.g. the counter
    button). The comment composer opens; save a comment. A
    numbered marker appears on the element.
 2. HMR survival: edit src/App.tsx (change the heading text)
    and save. The page hot-updates WITHOUT reloading; the
    pin either follows its element or disappears (fails
    closed). It must never sit on the wrong element.
 3. Reload: refresh the iframe page (right-click > reload
    frame, or navigate to the same URL). The bridge
    re-injects and the saved pin restores.
 4. SPA navigation: add a second route or use pushState from
    the devtools console:
      history.pushState({}, '', '/about')
    The annotations panel labels existing pins with their
    page; pins from the other page hide; new pins are
    stamped with /about.
 5. Vim and drag stay off: the drag/pinpoint switch is
    hidden; Alt does not flip to drag; no vim UI appears.
 6. Submit: Send Annotations. The feedback output groups
    entries under "### Page:" headings when several pages
    were annotated, and reaches the agent session verbatim.
============================================================
CHECKLIST

echo "==> Opening the live annotate session"
plannotator annotate "http://localhost:$VITE_PORT"

cat <<'NEXTJS'

============================================================
SECOND LOOP (manual): Next.js streaming SSR + webpack HMR
============================================================
Repeat the same checklist against a Next app to cover
streaming SSR injection and the /_next/webpack-hmr socket:

  cd "$(mktemp -d)"
  bunx create-next-app@latest next-smoke --ts --no-eslint \
    --no-tailwind --app --src-dir --import-alias "@/*"
  cd next-smoke && bun run dev --port 3005
  plannotator annotate http://localhost:3005

Watch specifically for: the bridge tag arriving in the
STREAMED head (view-source shows it right after <head>),
HMR websocket connecting through the proxy (no console
errors), and pins surviving a fast refresh.
============================================================
NEXTJS
