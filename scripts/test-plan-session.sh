#!/usr/bin/env bash
# Launch a test plan session against the running daemon.
# Usage: ./scripts/test-plan-session.sh

set -euo pipefail

DAEMON_JSON="$HOME/.plannotator/daemon.json"
if [ ! -f "$DAEMON_JSON" ]; then
  echo "No daemon running. Start one with: plannotator daemon start"
  exit 1
fi

PORT=$(python3 -c "import json; print(json.load(open('$DAEMON_JSON'))['port'])")
TOKEN=$(python3 -c "import json; print(json.load(open('$DAEMON_JSON'))['authToken'])")
BASE="http://localhost:$PORT"

echo "Daemon at $BASE"
echo "Creating plan session..."

curl -s -X POST "$BASE/daemon/sessions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "request": {
      "action": "plan",
      "origin": "claude-code",
      "cwd": "'"$(pwd)"'",
      "plan": "# Refactor Authentication Module\n\n## Overview\n\nMigrate the authentication system from session-based to JWT tokens. This reduces server-side state and simplifies horizontal scaling.\n\n## Phase 1: Token Infrastructure\n\n- [ ] Create `JWTService` class with sign/verify methods\n- [ ] Add `RS256` key pair generation on first boot\n- [ ] Store public key in `~/.config/auth/public.pem`\n- [ ] Add token expiry configuration (default: 24h access, 7d refresh)\n\n## Phase 2: Migration\n\n- [ ] Replace `express-session` middleware with `authenticateJWT` middleware\n- [ ] Update `/api/login` to return `{ accessToken, refreshToken }`\n- [ ] Add `/api/refresh` endpoint for token rotation\n- [ ] Migrate session data to JWT claims:\n  - `userId` → `sub` claim\n  - `role` → custom `role` claim\n  - `permissions` → custom `perms` claim (compressed)\n\n## Phase 3: Cleanup\n\n- [ ] Remove Redis session store dependency\n- [ ] Delete `SessionManager` class\n- [ ] Update API documentation\n- [ ] Add integration tests for token refresh flow\n\n## Risks\n\n> [!WARNING]\n> Token revocation requires a blocklist. Without it, compromised tokens remain valid until expiry.\n\n> [!NOTE]\n> Refresh token rotation mitigates this — each refresh invalidates the previous token.\n\n## Files to Modify\n\n| File | Change |\n|------|--------|\n| `src/auth/index.ts` | New JWT service |\n| `src/middleware/auth.ts` | Replace session check |\n| `src/routes/login.ts` | Return tokens |\n| `src/routes/refresh.ts` | New endpoint |\n| `src/config.ts` | Add JWT config |\n| `package.json` | Add jsonwebtoken, remove express-session |\n\n```typescript\n// src/auth/jwt-service.ts\nexport class JWTService {\n  constructor(private readonly privateKey: string) {}\n\n  sign(payload: TokenPayload): string {\n    return jwt.sign(payload, this.privateKey, {\n      algorithm: \"RS256\",\n      expiresIn: \"24h\",\n    });\n  }\n}\n```"
    }
  }' | python3 -m json.tool

echo ""
echo "Session created. Open the frontend to see it."
