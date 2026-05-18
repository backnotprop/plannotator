# WebSocket Event Hub

Replace the persistent runtime SSE streams with one WebSocket connection per mounted frontend instance, using the daemon as the multiplexing hub for daemon events, external annotations, agent jobs, and approval-loop actions. The server tracks only WebSocket connections and their connection-local subscriptions; it does not model browser tabs.

The shared understanding is in [facts.md](facts.md). The approved execution plan is in [plan.md](plan.md).

Done means the accepted facts are implemented and verified: daemon/session events flow through the WebSocket hub, old persistent SSE runtime routes are gone or nonfunctional, HTTP snapshots and mutations remain available, AI token streaming remains unchanged, and automated server plus browser tests cover auth, subscriptions, resync, filtering, actions, and disconnect cleanup.
