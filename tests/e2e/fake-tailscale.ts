import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const E2E_MAGIC = 'e2e-mac.tail0000.ts.net';
const MAGIC = E2E_MAGIC;

export function fakeTailscale(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'tailscale');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `dir='${dir}'`,
      'mode=$(cat "$dir/mode" 2>/dev/null)',
      'if [ "$1" = status ]; then',
      '  state=Running; [ "$mode" = signedout ] && state=NeedsLogin',
      `  echo "{\\"BackendState\\":\\"$state\\",\\"Self\\":{\\"DNSName\\":\\"${MAGIC}.\\",\\"UserID\\":1},\\"User\\":{\\"1\\":{\\"LoginName\\":\\"e2e@example.com\\"}},\\"CertDomains\\":[\\"${MAGIC}\\"]}"`,
      '  exit 0',
      'fi',
      'if [ "$1" = serve ] && [ "$2" = status ]; then',
      `  if [ -f "$dir/proxy" ]; then echo "{\\"TCP\\":{\\"8443\\":{\\"HTTPS\\":true}},\\"Web\\":{\\"${MAGIC}:8443\\":{\\"Handlers\\":{\\"/\\":{\\"Proxy\\":\\"$(cat "$dir/proxy")\\"}}}}}"; else echo '{}'; fi`,
      '  exit 0',
      'fi',
      'if [ "$1" = serve ]; then',
      '  case "$*" in *off*) rm -f "$dir/proxy"; exit 0;; esac',
      '  for last; do :; done',
      '  echo "$last" > "$dir/proxy"',
      `  printf 'Available within your tailnet:\\n\\nhttps://${MAGIC}:8443/\\n'`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return dir;
}

