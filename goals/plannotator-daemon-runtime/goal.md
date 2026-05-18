# Long-Running Plannotator Daemon Runtime

Build the real Plannotator daemon runtime as a stacked PR on top of `feat/single-server-runtime`. Plannotator should have one long-running binary-owned daemon process per user/machine environment, and daemon-backed CLI/plugin commands should create session-scoped plan, review, annotate, and archive sessions through that central process.

The shared understanding is in [facts.md](facts.md). The approved execution plan is in [plan.md](plan.md).

Done when the accepted facts are verified, the daemon runtime supports session-scoped concurrent browser sessions on one shared endpoint, CLI/plugin commands route through the daemon without changing public behavior, remote mode is explicitly preserved, and the final functionality inventory proves every accepted fact and compatibility surface.
