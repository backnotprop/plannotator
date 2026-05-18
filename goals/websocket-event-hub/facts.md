# Facts

- A WebSocket connection can subscribe and unsubscribe to specific session IDs and event families.
- When a connection subscribes, the daemon sends a current snapshot for that subscription before sending future delta events.
- When a browser reconnects, the frontend resubscribes and resyncs snapshots before applying new deltas.
- The local runtime shell opens one persistent WebSocket connection per mounted frontend instance and does not open persistent EventSource connections.
- Daemon lifecycle and debug events are delivered through the WebSocket hub instead of the `/daemon/events` SSE stream.
- External annotation live updates are delivered through the WebSocket hub instead of `/api/external-annotations/stream`.
- Agent job live updates are delivered through the WebSocket hub instead of `/api/agents/jobs/stream`.
- The old persistent SSE routes for daemon events, external annotations, and agent jobs are removed or made nonfunctional for runtime use in this goal.
- Existing HTTP snapshot and mutation endpoints remain available for resync, writes, uploads, and large payloads.
- AI query token streaming remains out of scope for this goal and continues to use its current request/response transport.
- The WebSocket protocol supports session action commands needed for the approval loop, with correlated success and error replies.
- The WebSocket hub sends heartbeats and cleans up connection-local subscriptions when a socket closes or stops responding.
- Automated tests cover daemon WebSocket auth, subscription filtering, snapshot-before-delta ordering, reconnect/resync behavior, session action replies, and cleanup on disconnect.
- Automated browser tests verify that the frontend receives daemon, external annotation, and agent job updates through one WebSocket connection and does not instantiate EventSource for those updates.
- Session-scoped event producers for external annotations and agent jobs publish events upward into the daemon WebSocket hub instead of maintaining independent per-session persistent subscriber sets.
