# Agent Simulator End-to-End Runner

Build a standalone OpenTUI end-to-end runner that simulates supported Plannotator agent protocols by spawning the real Plannotator command, feeding realistic stdin/env/files, observing daemon sessions, and verifying stdout/stderr/result behavior. Add focused daemon event streaming and frontend debug panels so the browser shell can visibly show daemon/session events while the runner drives scenarios.

Use [facts.md](./facts.md) as the accepted behavior contract. Use [plan.md](./plan.md) as the approved execution plan.

Done when the runner covers the accepted fixture-backed scenarios, the daemon exposes tested lifecycle events, the frontend shell renders live or fallback-polled debug JSON with simple session action buttons, and at least one automated full process-to-daemon completion path proves the real stdin/stdout loop.
