# Tests

## Manual Tests

### Local Hook Simulation (`manual/local/`)

Simulates the Claude Code hook locally for testing the UI.

```bash
./tests/manual/local/test-hook.sh
```

Builds the hook, pipes a sample plan to the server, and opens the browser. Test approving/denying and check the hook output.

### SSH Remote Support (`manual/ssh/`)

Tests SSH session detection and port forwarding for remote development scenarios.

See [manual/ssh/DOCKER_SSH_TEST.md](manual/ssh/DOCKER_SSH_TEST.md) for setup instructions.
