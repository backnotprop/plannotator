// Imported FIRST by index.ts, so it runs before any other module's top-level
// code and before any fetch: the CLI's loopback requests (Inbox health, its
// own servers) ignore a proxy the person's shell exports, and every child it
// starts inherits the same NO_PROXY (packages/shared/loopback-proxy.ts).
import { bypassProxyForLoopback } from "@plannotator/shared/loopback-proxy";

bypassProxyForLoopback(process.env);
