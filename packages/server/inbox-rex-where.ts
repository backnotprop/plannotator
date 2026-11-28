/**
 * Plannotator Inbox: where this computer's Rex server (superlogical.com/rex) listens, on any system Rex runs on.
 *
 * Rex's Mac app runs its own server (`~/Library/Application Support/rex/server.sock`). On Linux and FreeBSD Rex is a
 * server with no app on that machine (a "personal server" of the account, started by `rex server start`,
 * `rex server install` or any `rex` command), and Rex's apps attach to it from other computers. Rex's manual
 * (superlogical.com/rex/docs/linux/server-modes, "Personal Server") says where its socket is:
 *
 *   - "in `$XDG_RUNTIME_DIR/rex`, which is usually `/run/user/<uid>/rex`";
 *   - on FreeBSD, and on Linux machines without `/run/user` (many containers), "in `~/.local/state/rex/run`"
 *     (state is in `$XDG_STATE_HOME/rex` when that is set);
 *   - "or in `REX_RUNTIME_DIR` instead if you've set it".
 *
 * and how a person points `rex` at another server on the machine, such as the shared server's
 * `/run/rex/server.sock` (linux/shared-server, "Giving People Access"): `REX_SERVER`, which Rex also sets in every
 * terminal it opens to "the address of the server that runs the terminal" (automate/cli).
 *
 * The manual names the folder, not the file in it. `server.sock` is the name it gives the shared server's socket
 * (`/run/rex/server.sock`) and the one the Mac app's server uses; a personal server on Linux is taken to use it too.
 * A real Linux server has to confirm that (`rex server status`); if it differs, only `REX_SERVER` finds it.
 *
 * Nothing here starts a server or runs `rex`: these are paths to look at. `inbox-rex.ts` connects to the first that
 * is a socket (and, for a path found by convention, this user's own).
 */
import { join } from "node:path";

/** The file a Rex server's socket has in its runtime folder. */
const SOCKET_NAME = "server.sock";

/** One place a Rex server may listen. `named`: the person (or Rex's own terminal) named it, so it need not be this user's own. */
export interface InboxRexSocket {
  path: string;
  named?: true;
}

/**
 * The Inbox's own name for `REX_SERVER`. The detached Inbox drops the Rex pane it was started from (`withoutRexPane`,
 * `REX_SERVER` included, so no agent it starts inherits a pane); the server's address is carried under this name.
 */
export const INBOX_REX_SERVER_ENV = "PLANNOTATOR_INBOX_REX_SERVER";

/**
 * The unix socket a `REX_SERVER` value names, or null: a full path, `unix://<path>` or `unix:<path>`. Anything else
 * (an `https://`, `ssh://` or tailnet address, a host's label) is another computer's server, never this one's. The
 * `unix:` forms are URLs, percent-encoded as Rex writes them in every tab (`unix:///Users/ada/Library/Application%20Support/rex/server.sock`),
 * so they are decoded; a bad escape names nothing (the next place is looked at). A bare path is taken as it is.
 */
export function inboxRexServerSocket(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text || /[\0\n\r]/.test(text)) return null;
  const url = text.startsWith("unix://") ? text.slice("unix://".length) : text.startsWith("unix:") ? text.slice("unix:".length) : null;
  let path = text;
  if (url !== null) {
    try {
      path = decodeURIComponent(url);
    } catch {
      return null;
    }
    if (/[\0\n\r]/.test(path)) return null;
  }
  return path.startsWith("/") && path.length > 1 ? path : null;
}

/**
 * Where this computer's Rex server may listen, the likeliest first: the server the environment names (`REX_SERVER`),
 * then Rex's own runtime folder (`REX_RUNTIME_DIR`), then where a personal server lives on this system. On macOS the
 * app's server comes first, before either: a Mac whose app runs is read exactly as before, whatever is set. None on
 * Windows (a named pipe, which this client does not speak).
 */
export function inboxRexSockets(platform: string, homeDir: string, env: Readonly<Record<string, string | undefined>>, uid: number | null): InboxRexSocket[] {
  if (platform === "win32") return [];
  const out: InboxRexSocket[] = [];
  const add = (path: string | null, named?: true) => {
    if (path && !out.some((known) => known.path === path)) out.push(named ? { path, named } : { path });
  };
  const dir = (value: string | undefined) => (value && value.startsWith("/") ? value : null);
  const runtime = dir(env.REX_RUNTIME_DIR);
  // A Mac: the app's own server first, whatever the environment names (an Inbox started from a Rex tab keeps that
  // tab's `REX_SERVER` for its whole life), so a Mac whose app runs is read exactly as before.
  if (platform === "darwin") add(join(homeDir, "Library", "Application Support", "rex", SOCKET_NAME));
  add(inboxRexServerSocket(env[INBOX_REX_SERVER_ENV]) ?? inboxRexServerSocket(env.REX_SERVER), true);
  if (runtime) add(join(runtime, SOCKET_NAME));
  if (platform === "darwin") return out;
  const xdgRuntime = dir(env.XDG_RUNTIME_DIR);
  if (xdgRuntime) add(join(xdgRuntime, "rex", SOCKET_NAME));
  // An Inbox started without a login session's env (a service, a hook) still finds the usual folder.
  if (platform === "linux" && uid !== null) add(join("/run/user", String(uid), "rex", SOCKET_NAME));
  const xdgState = dir(env.XDG_STATE_HOME);
  if (xdgState) add(join(xdgState, "rex", "run", SOCKET_NAME));
  if (homeDir) add(join(homeDir, ".local", "state", "rex", "run", SOCKET_NAME));
  return out;
}

/**
 * The socket this computer's Rex is reached on, from `inboxRexSockets`' list: the first that is a socket of this user's
 * own (named or found by convention), else the first named one that is a socket at all (another account's, such as a
 * shared server: read, never started on). So a shared server named by `REX_SERVER` never hides the person's own
 * personal server, where agents can start. `isSocket(path, uid)`: a socket there, owned by `uid` (null: anyone).
 */
export function inboxRexSocketPick(sockets: readonly InboxRexSocket[], isSocket: (path: string, uid: number | null) => boolean, uid: number | null): string | null {
  return sockets.find((socket) => isSocket(socket.path, uid))?.path ?? sockets.find((socket) => socket.named && isSocket(socket.path, null))?.path ?? null;
}

/**
 * Whether Rex on this system is a server with no app of its own beside it: everywhere but macOS, where the app runs
 * the server. There, a start needs no app, and Show in Rex goes through whichever Rex apps are attached from other
 * computers (`inbox-rex.ts`).
 */
export function inboxRexHeadless(platform: string): boolean {
  return platform !== "darwin";
}
