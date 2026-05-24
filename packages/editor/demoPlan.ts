export const DEMO_PLAN_CONTENT = `# Implementation Plan: Real-time Collaboration

## Context

This proposal introduces real-time collaborative editing to the Plannotator editor, letting reviewers annotate the same plan simultaneously with sub-second visibility of each other's cursors and edits. We are targeting **production-grade concurrency** for up to 50 active collaborators per document, with end-to-end edit-to-visible latency under 150ms at the 95th percentile. The implementation uses operational transforms running on a dedicated Node.js gateway that speaks \`WebSocket\` to clients and \`gRPC\` to the storage tier. See [the technical design doc](https://docs.example.com/realtime-v2) for the full rationale and rollout plan. The editor entry point is [App.tsx](packages/editor/App.tsx) and the server config lives in [server/index.ts](packages/server/index.ts).

Runtime parameters for phase one:

\`\`\`typescript
export const COLLAB_CONFIG = {
  maxCollaborators: 50,
  heartbeatIntervalMs: 5_000,
  operationBatchSize: 32,
  gateway: "wss://collab.plannotator.ai",
} as const;
\`\`\`

### Configuration reference

| Parameter | Value | Description |
| --- | --- | --- |
| \`maxCollaborators\` | 50 | Hard ceiling per document before the gateway rejects new joins |
| \`heartbeatIntervalMs\` | 5 000 ms | Ping cadence; three missed heartbeats trigger a reconnect |
| \`operationBatchSize\` | 32 | Max ops coalesced into a single WebSocket frame |
| \`gateway\` | \`wss://collab.plannotator.ai\` | Regional edge endpoint; clients are routed by latency |

### Key files

| File | Role |
| --- | --- |
| \`packages/editor/App.tsx\` | Editor entry point |
| \`packages/shared/resolve-file.ts\` | Path resolution |
| \`packages/fake/nope.ts\` | Should fail silently |
| \`package.json\` | Root config |

## Overview
Add real-time collaboration features to the editor using _**[WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)**_ and *[operational transforms](https://en.wikipedia.org/wiki/Operational_transformation)*. The core rendering logic is in \`packages/ui/components/Viewer.tsx:140-180\` and the block parser at \`packages/ui/utils/parser.ts:261-286\`.

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
  - Handle connection state changes (connecting, open, closing, closed)
- Implement reconnection logic with exponential backoff
  - Start with 1 second delay
  - Double delay on each retry (max 30 seconds)
  - Reset delay on successful connection
- Handle offline state gracefully
  - Queue local changes in IndexedDB
  - Show offline indicator in UI
  - Sync queued changes on reconnect

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
    - Option A: Move insert to delete start position
    - Option B: Discard the insert entirely
  - Insert after delete: adjust insert position
- Transform delete against delete
  - Non-overlapping: adjust positions
  - Overlapping: merge or split operations
- Maintain cursor positions across transforms
  - Track cursor as a zero-width insert operation
  - Update cursor position after each transform

### Transform Implementation

\`\`\`typescript
interface Operation {
  type: 'insert' | 'delete';
  position: number;
  content?: string;
  length?: number;
  userId: string;
  timestamp: number;
}

class OperationalTransform {
  private pendingOps: Operation[] = [];
  private history: Operation[] = [];

  transform(op1: Operation, op2: Operation): [Operation, Operation] {
    if (op1.type === 'insert' && op2.type === 'insert') {
      if (op1.position <= op2.position) {
        return [op1, { ...op2, position: op2.position + (op1.content?.length || 0) }];
      } else {
        return [{ ...op1, position: op1.position + (op2.content?.length || 0) }, op2];
      }
    }

    if (op1.type === 'delete' && op2.type === 'delete') {
      // Complex delete vs delete transformation
      const op1End = op1.position + (op1.length || 0);
      const op2End = op2.position + (op2.length || 0);

      if (op1End <= op2.position) {
        return [op1, { ...op2, position: op2.position - (op1.length || 0) }];
      }
      // ... more cases
    }

    return [op1, op2];
  }

  apply(doc: string, op: Operation): string {
    if (op.type === 'insert') {
      return doc.slice(0, op.position) + op.content + doc.slice(op.position);
    } else {
      return doc.slice(0, op.position) + doc.slice(op.position + (op.length || 0));
    }
  }
}
\`\`\`

## Phase 3: UI Updates

1. Show collaborator cursors in real-time
   - Render cursor as colored vertical line
   - Add name label above cursor
   - Animate cursor movement smoothly
2. Display presence indicators
   - Avatar stack in header
   - Dropdown with full collaborator list
     - Show online/away status
     - Display last activity time
     - Allow @mentioning collaborators
3. Add conflict resolution UI
   - Highlight conflicting regions
   - Show diff comparison panel
   - Provide merge options:
     - Accept mine
     - Accept theirs
     - Manual merge
4. Implement undo/redo stack per user
   - Track operations by user ID
   - Allow undoing only own changes
   - Show undo history in sidebar

### React Component for Cursors

\`\`\`tsx
import React, { useEffect, useState } from 'react';
import { useCollaboration } from '../hooks/useCollaboration';

interface CursorOverlayProps {
  documentId: string;
  containerRef: React.RefObject<HTMLDivElement>;
}

export const CursorOverlay: React.FC<CursorOverlayProps> = ({
  documentId,
  containerRef
}) => {
  const { collaborators, currentUser } = useCollaboration(documentId);
  const [positions, setPositions] = useState<Map<string, DOMRect>>(new Map());

  useEffect(() => {
    const updatePositions = () => {
      const newPositions = new Map<string, DOMRect>();
      collaborators.forEach(collab => {
        if (collab.userId !== currentUser.id && collab.cursorPosition) {
          const rect = getCursorRect(containerRef.current, collab.cursorPosition);
          if (rect) newPositions.set(collab.userId, rect);
        }
      });
      setPositions(newPositions);
    };

    const interval = setInterval(updatePositions, 50);
    return () => clearInterval(interval);
  }, [collaborators, currentUser, containerRef]);

  return (
    <>
      {Array.from(positions.entries()).map(([userId, rect]) => (
        <div
          key={userId}
          className="absolute pointer-events-none transition-all duration-75"
          style={{
            left: rect.left,
            top: rect.top,
            height: rect.height,
          }}
        >
          <div className="w-0.5 h-full bg-blue-500 animate-pulse" />
          <div className="absolute -top-5 left-0 px-1.5 py-0.5 bg-blue-500
                          text-white text-xs rounded whitespace-nowrap">
            {collaborators.find(c => c.userId === userId)?.userName}
          </div>
        </div>
      ))}
    </>
  );
};
\`\`\`

### Configuration

\`\`\`json
{
  "collaboration": {
    "enabled": true,
    "maxCollaborators": 10,
    "cursorColors": ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"],
    "syncInterval": 100,
    "reconnect": {
      "maxAttempts": 5,
      "backoffMultiplier": 1.5,
      "initialDelay": 1000
    }
  }
}
\`\`\`

---

## Pre-launch Checklist

- [ ] Infrastructure ready
  - [x] WebSocket server deployed
  - [x] Database migrations applied
  - [ ] Load balancer configured
    - [ ] SSL certificates installed
    - [ ] Health checks enabled
      - [ ] /health endpoint returns 200
      - [ ] /ready endpoint checks DB connection
        - [ ] Primary database
        - [ ] Read replicas
          - [ ] us-east-1 replica
          - [ ] eu-west-1 replica
- [ ] Security audit complete
  - [x] Authentication flow reviewed
  - [ ] Rate limiting implemented
    - [x] 100 req/min for anonymous users
    - [ ] 1000 req/min for authenticated users
  - [ ] Input sanitization verified
- [x] Documentation updated
  - [x] API reference generated
  - [x] Integration guide written
  - [ ] Video tutorials recorded

### API Endpoints

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | /api/documents | List all documents | Required |
| POST | /api/documents | Create new document | Required |
| GET | /api/documents/:id | Fetch document | Required |
| PUT | /api/documents/:id | Update document | Owner/Editor |
| DELETE | /api/documents/:id | Delete document | Owner only |
| POST | /api/documents/:id/share | Share document | Owner only |
| GET | /api/documents/:id/collaborators | List collaborators | Required |

### Performance Targets

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| WebSocket latency | < 50ms | 42ms | On track |
| Time to first cursor | < 200ms | 310ms | **At risk** |
| Concurrent users/doc | 50 | 25 | In progress |
| Operation transform | < 5ms | 3ms | On track |
| Reconnect time | < 2s | 1.8s | On track |

### Mixed List Styles

* Asterisk item at level 0
  - Dash item at level 1
    * Asterisk at level 2
      - Dash at level 3
        * Asterisk at level 4
          - Maximum reasonable depth
1. Numbered item
   - Sub-bullet under numbered
   - Another sub-bullet
     1. Nested numbered list
     2. Second nested number

---

## Appendix: Diagrams

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

### Service Dependencies (Graphviz)

\`\`\`graphviz
digraph CollaborationStack {
  rankdir=LR;
  node [shape=box, style="rounded"];

  Browser [label="Client Browser"];
  API [label="WebSocket API"];
  OT [label="OT Engine"];
  Redis [label="Presence Cache"];
  Postgres [label="PostgreSQL"];

  Browser -> API;
  API -> OT;
  OT -> Redis;
  OT -> Postgres;
}
\`\`\`

---

## Phase 4: File Changes

### Modified files

The core connection logic lives in \`packages/ui/components/InlineMarkdown.tsx\` which handles rendering inline tokens. The detection utility is in \`packages/shared/code-file.ts\` and the popout viewer is wired through \`packages/ui/hooks/useCodeFilePopout.ts\`.

On the server side, update packages/server/index.ts to register the new WebSocket routes and packages/server/reference-handlers.ts for the file resolution endpoint. The editor entry point \`packages/editor/App.tsx\` needs the collaboration provider wrapper.

### Build and deploy

- Update the \`Dockerfile\` to expose the new WebSocket port
- Run \`package.json\` scripts for the build pipeline
- Config files like \`.env\` and \`README.md\` do not need changes
- Commands like \`npm install\` and \`bun run build\` remain unchanged

**Target:** Ship MVP in next sprint
`;
