/**
 * Vite plugin that mocks plannotator API endpoints for local development.
 * Provides plan data with version history so the Versions tab works in dev mode.
 */
import type { Plugin } from 'vite';

// Version 1: earlier draft (shorter, missing sections)
const PLAN_V1 = `# Implementation Plan: Real-time Collaboration

## Overview
Add real-time collaboration features to the editor using WebSocket connections.

## Phase 1: Infrastructure

### WebSocket Server
Set up a WebSocket server to handle concurrent connections:

\`\`\`typescript
const server = new WebSocketServer({ port: 8080 });

server.on('connection', (socket) => {
  const sessionId = generateSessionId();
  sessions.set(sessionId, socket);

  socket.on('message', (data) => {
    broadcast(sessionId, data);
  });
});
\`\`\`

### Client Connection
- Establish persistent connection on document load
- Implement reconnection logic with exponential backoff
- Handle offline state gracefully

### Database Schema

\`\`\`sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
\`\`\`

## Phase 2: Operational Transforms

> The key insight is that we need to transform operations against concurrent operations to maintain consistency.

Key requirements:
- Transform insert against insert
- Transform insert against delete
- Transform delete against delete

## Pre-launch Checklist

- [ ] Infrastructure ready
  - [ ] WebSocket server deployed
  - [ ] Database migrations applied
- [ ] Security audit complete
- [ ] Documentation updated

---

**Target:** Ship MVP in next sprint
`;

// Version 2: expanded (added architecture diagram, more details)
const PLAN_V2 = `# Implementation Plan: Real-time Collaboration

## Overview
Add real-time collaboration features to the editor using WebSocket connections and operational transforms.

### Architecture

\`\`\`mermaid
flowchart LR
    subgraph Client["Client Browser"]
        UI[React UI] --> OT[OT Engine]
        OT <--> WS[WebSocket Client]
    end

    subgraph Server["Backend"]
        WSS[WebSocket Server] <--> OTS[OT Transform]
        OTS <--> DB[(PostgreSQL)]
    end

    WS <--> WSS
\`\`\`

## Phase 1: Infrastructure

### WebSocket Server
Set up a WebSocket server to handle concurrent connections:

\`\`\`typescript
const server = new WebSocketServer({ port: 8080 });

server.on('connection', (socket, request) => {
  const sessionId = generateSessionId();
  sessions.set(sessionId, socket);

  socket.on('message', (data) => {
    broadcast(sessionId, data);
  });
});
\`\`\`

### Client Connection
- Establish persistent connection on document load
  - Initialize WebSocket with authentication token
  - Set up heartbeat ping/pong every 30 seconds
- Implement reconnection logic with exponential backoff
  - Start with 1 second delay
  - Double delay on each retry (max 30 seconds)
- Handle offline state gracefully
  - Queue local changes in IndexedDB
  - Show offline indicator in UI

### Database Schema

\`\`\`sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role VARCHAR(50) DEFAULT 'editor',
  cursor_position JSONB,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_collaborators_document ON collaborators(document_id);
\`\`\`

## Phase 2: Operational Transforms

> The key insight is that we need to transform operations against concurrent operations to maintain consistency.

Key requirements:
- Transform insert against insert
  - Same position: use user ID for deterministic ordering
  - Different positions: adjust offset of later operation
- Transform insert against delete
  - Insert before delete: no change needed
  - Insert inside deleted range: special handling required
- Transform delete against delete
  - Non-overlapping: adjust positions
  - Overlapping: merge or split operations
- Maintain cursor positions across transforms

## Phase 3: UI Updates

1. Show collaborator cursors in real-time
2. Display presence indicators
3. Add conflict resolution UI
4. Implement undo/redo stack per user

## Pre-launch Checklist

- [ ] Infrastructure ready
  - [x] WebSocket server deployed
  - [x] Database migrations applied
  - [ ] Load balancer configured
- [ ] Security audit complete
  - [x] Authentication flow reviewed
  - [ ] Rate limiting implemented
- [x] Documentation updated

---

**Target:** Ship MVP in next sprint
`;

// Version 3 is the current PLAN_CONTENT from App.tsx (loaded by the editor itself)
// We don't duplicate it here — the editor already has it as the default state.

const now = Date.now();
const versions = [
  { version: 1, timestamp: new Date(now - 3600_000 * 2).toISOString() },
  { version: 2, timestamp: new Date(now - 3600_000).toISOString() },
  { version: 3, timestamp: new Date(now - 60_000).toISOString() },
];

const versionPlans: Record<number, string> = {
  1: PLAN_V1,
  2: PLAN_V2,
  // Version 3 is the current plan — served via /api/plan
};

export function devMockApi(): Plugin {
  return {
    name: 'plannotator-dev-mock-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/api/plan') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            plan: undefined, // Let editor use its own PLAN_CONTENT
            origin: 'claude-code',
            previousPlan: PLAN_V2,
            versionInfo: { version: 3, totalVersions: 3, project: 'demo' },
            sharingEnabled: true,
          }));
          return;
        }

        if (req.url === '/api/plan/versions') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            project: 'demo',
            slug: 'implementation-plan-real-time-collab',
            versions,
          }));
          return;
        }

        if (req.url?.startsWith('/api/plan/version?')) {
          const url = new URL(req.url, 'http://localhost');
          const v = Number(url.searchParams.get('v'));
          const plan = versionPlans[v];
          if (plan) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ plan, version: v }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Version not found' }));
          }
          return;
        }

        if (req.url === '/api/plan/history') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            project: 'demo',
            plans: [{
              slug: 'implementation-plan-real-time-collab',
              versions: 3,
              lastModified: new Date(now - 60_000).toISOString(),
            }],
          }));
          return;
        }

        next();
      });
    },
  };
}
