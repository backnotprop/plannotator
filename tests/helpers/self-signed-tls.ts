/**
 * A private certificate authority and a server certificate for 127.0.0.1,
 * made with `openssl` in a temp dir: the stand-in for a network that inspects
 * HTTPS with its own root, which Bun's built-in roots do not hold. Works with
 * OpenSSL and with macOS's LibreSSL.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SelfSignedTls {
  /** The root's certificate (PEM), and its file: what NODE_EXTRA_CA_CERTS points at. */
  caPem: string;
  caFile: string;
  /** The server's certificate and key, for Bun.serve({ tls }). */
  cert: string;
  key: string;
}

function openssl(dir: string, args: string[]): void {
  const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr || r.error?.message}`);
}

export function makeSelfSignedTls(dir: string): SelfSignedTls {
  writeFileSync(join(dir, "ca.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n");
  writeFileSync(join(dir, "leaf.cnf"), "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n");
  openssl(dir, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Plannotator Test Inspecting Root", "-config", "ca.cnf", "-extensions", "v3_ca"]);
  openssl(dir, ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=127.0.0.1", "-config", "ca.cnf"]);
  openssl(dir, ["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.cnf"]);
  return {
    caPem: readFileSync(join(dir, "ca.pem"), "utf-8"),
    caFile: join(dir, "ca.pem"),
    cert: readFileSync(join(dir, "leaf.pem"), "utf-8"),
    key: readFileSync(join(dir, "leaf.key"), "utf-8"),
  };
}
