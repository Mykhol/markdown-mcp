// Membership in the shared viewer.
//
// Every session starts its own MCP process, but they present one viewer: each
// process tries to bind a fixed port, and whichever wins serves the pages while
// the rest push their renders to it. The bind is the election — the port is the
// mutex, so there is no daemon and no lock file.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Reserved prefix for the viewer's own endpoints, so it can never collide with
// a user-chosen view path.
export const INTERNAL_PREFIX = "/__mdv";
export const HEALTH_ENDPOINT = `${INTERNAL_PREFIX}/health`;
export const RENDER_ENDPOINT = `${INTERNAL_PREFIX}/render`;
export const CLEAR_ENDPOINT = `${INTERNAL_PREFIX}/clear`;
export const PATHS_ENDPOINT = `${INTERNAL_PREFIX}/paths`;

export const SERVER_ID = "mcp-markdown-viewer";
// Bumped only when the control endpoints change shape. A host advertising a
// different number is talked to by nobody; the newcomer runs standalone.
export const CONTROL_VERSION = 1;
const DEFAULT_PORT = 7391;

export type ViewerMode = "host" | "client";

let mode: ViewerMode = "host";
let serverPort = 0;
let becameHostAt = 0;
let buildApp: () => RequestListener;
let attachSockets: (server: Server) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `MDV_PORT=0` opts out of sharing entirely and takes a private random port.
function preferredPort(): number | null {
  const raw = process.env.MDV_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    // Falling back silently would join the shared viewer, which is the opposite
    // of what someone setting this variable to isolate themselves intended.
    console.error(`Ignoring MDV_PORT=${raw}: not a port number. Using ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return parsed === 0 ? null : parsed;
}

// Resolves to the bound server, or null if the port is taken.
function listenOn(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    // Loopback only — the image endpoint reads local files, so the server has
    // no business being reachable from the rest of the network.
    const server = createServer(buildApp());
    const onError = () => resolve(null);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

async function isSiblingViewer(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${HEALTH_ENDPOINT}`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { server?: string; control?: number };
      return body.server === SERVER_ID && body.control === CONTROL_VERSION;
    } catch {
      // The winner of a simultaneous start may still be mid-bind. A stranger
      // holding the port keeps refusing, so the retries cost nothing.
      await delay(150);
    }
  }
  return false;
}

function becomeHost(server: Server, port: number): ViewerMode {
  serverPort = port;
  mode = "host";
  becameHostAt = Date.now();
  attachSockets(server);
  console.error(`Markdown viewer running at http://localhost:${port}`);
  return mode;
}

function becomeClient(port: number): ViewerMode {
  serverPort = port;
  mode = "client";
  console.error(`Markdown viewer already running at http://localhost:${port} — sharing it`);
  return mode;
}

// The one election, run both at startup and again when the host disappears, so
// the two cases can never drift into disagreeing about the fallback.
async function elect(): Promise<ViewerMode> {
  const preferred = preferredPort();

  if (preferred !== null) {
    const bound = await listenOn(preferred);
    if (bound) return becomeHost(bound, preferred);
    if (await isSiblingViewer(preferred)) return becomeClient(preferred);
    console.error(
      `Port ${preferred} is held by something else — starting a private viewer instead.`,
    );
  }

  const own = await listenOn(0);
  if (!own) throw new Error("Could not bind a port for the markdown viewer");
  return becomeHost(own, (own.address() as AddressInfo).port);
}

export async function join(
  app: () => RequestListener,
  sockets: (server: Server) => void,
): Promise<void> {
  buildApp = app;
  attachSockets = sockets;
  await elect();
}

// Anything undici throws for a loopback request is a transport failure: the only
// other throw from callHost is the explicit Error below.
function isConnectionFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

async function callHost<T>(endpoint: string, body?: object): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${serverPort}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const failure = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(failure.error || `Viewer host returned ${res.status}`);
  }
  // Deliberately not tolerant of a broken body on a 2xx: a host that dies after
  // its headers would otherwise report a successful render of nothing.
  return (await res.json()) as T;
}

// Client operations retry once through a fresh election, so the death of the
// host session costs the next render a reconnect rather than an error.
export async function viaHost<T>(remote: () => Promise<T>, local: () => Promise<T>): Promise<T> {
  if (mode === "host") return local();
  try {
    return await remote();
  } catch (err) {
    if (!isConnectionFailure(err)) throw err;
    return (await elect()) === "host" ? local() : remote();
  }
}

export async function control<T>(endpoint: string, body?: object): Promise<T> {
  return callHost<T>(endpoint, body);
}

export function getPort(): number {
  return serverPort;
}

// How long this process has been serving. A page orphaned by the previous host
// needs a moment to notice and reconnect, and only the clock distinguishes that
// from a page that was never open.
export function hostUptimeMs(): number {
  return mode === "host" ? Date.now() - becameHostAt : Infinity;
}
