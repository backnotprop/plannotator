# Testing SSH Remote Support with Docker

This setup creates a Docker container with SSH server to test Plannotator's SSH remote session detection.

## Build and Run

```bash
# From repo root, cd into this directory
cd tests/manual/ssh

# Build the Docker image
docker-compose build

# Start the SSH server
docker-compose up -d

# Check it's running
docker-compose ps
```

## Test SSH Detection

### Option 1: SSH into the container and run test script

```bash
# SSH into the container (password: testpass)
ssh -p 2222 root@localhost

# Once inside, run the test script
cd /app
chmod +x test-ssh.sh
./test-ssh.sh
```

You should see:
- `[SSH Remote Session Detected]` message
- A reachable URL (Tailscale/`PLANNOTATOR_HOSTNAME`) or a read-only share link
- Server running on a random port (set `PLANNOTATOR_PORT` to pin it for forwarding)

### Option 2: Test via SSH with port forwarding

Remote sessions use a random port by default, so pin one with `PLANNOTATOR_PORT`
to forward it:

```bash
# In one terminal, SSH with port forwarding
ssh -p 2222 -L 19432:localhost:19432 root@localhost

# Inside the SSH session, run (pin the port so forwarding lines up):
cd /app
echo '{"tool_input":{"plan":"# Test Plan\n\nTest content"}}' | PLANNOTATOR_PORT=19432 bun run apps/hook/server/index.ts

# In another terminal on your local machine, open browser
open http://localhost:19432
```

### Option 3: Test local (non-SSH) mode

```bash
# Execute directly in container without SSH
docker-compose exec plannotator-ssh bash -c 'cd /app && echo "{\"tool_input\":{\"plan\":\"# Test Plan\n\nTest content\"}}" | bun run apps/hook/server/index.ts'
```

You should see:
- NO `[SSH Remote Session Detected]` message
- Random port assignment (since SSH_TTY and SSH_CONNECTION are not set)

## Verify SSH Environment Variables

```bash
# SSH into container
ssh -p 2222 root@localhost

# Check SSH env vars are set
echo "SSH_TTY: $SSH_TTY"
echo "SSH_CONNECTION: $SSH_CONNECTION"
```

## Clean Up

```bash
docker-compose down
```

## Environment Variable Override

To test custom port:

```bash
ssh -p 2222 root@localhost
cd /app
PLANNOTATOR_PORT=9999 ./test-ssh.sh
```

Server should use port 9999 instead of a random port.
