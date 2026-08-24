import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import open from "open";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { VERSION } from "./version.js";
import {
  CLEAR_ENDPOINT,
  CONTROL_VERSION,
  HEALTH_ENDPOINT,
  INTERNAL_PREFIX,
  PATHS_ENDPOINT,
  RENDER_ENDPOINT,
  SERVER_ID,
  control,
  getPort,
  hostUptimeMs,
  join,
  viaHost,
} from "./peer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-path content and client tracking
const contentByPath = new Map<string, string>();
const clientsByPath = new Map<string, Set<WebSocket>>();
// Directory that relative image paths in each page's markdown resolve against:
// the file's own directory for render_file, the server's cwd otherwise.
const baseDirByPath = new Map<string, string>();

export { getPort } from "./peer.js";

export const IMAGE_ENDPOINT = `${INTERNAL_PREFIX}/image`;

// A tab that was just opened has not connected its WebSocket yet, so back-to-back
// renders would otherwise each decide the page is unattended and open again.
const OPEN_GRACE_MS = 5000;
// How long a freshly promoted host waits for pages orphaned by its predecessor
// to find their way back. Must exceed the viewer's reconnect ceiling.
const SETTLE_MS = 2500;
const openAttempts = new Map<string, number>();

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function normalizePath(p: string | undefined): string {
  const raw = (p || "/").replace(/\/+$/, "") || "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClients(viewPath: string): Set<WebSocket> {
  let set = clientsByPath.get(viewPath);
  if (!set) {
    set = new Set();
    clientsByPath.set(viewPath, set);
  }
  return set;
}

function broadcast(viewPath: string, message: object): void {
  const payload = JSON.stringify(message);
  const clients = clientsByPath.get(viewPath);
  if (!clients) return;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function getBaseDir(viewPath: string = "/"): string {
  return baseDirByPath.get(normalizePath(viewPath)) || process.cwd();
}

// Turn a markdown image src into an absolute filesystem path, resolving `~`
// and `file://` forms and anything relative against the page's base dir.
export function resolveImagePath(src: string, viewPath: string = "/"): string {
  let raw = src.trim();
  if (raw.startsWith("file://")) {
    raw = fileURLToPath(raw);
  } else {
    // Only strip a query/fragment from plain paths — a literal `?` or `#` is
    // legal in a filename, but URL-ish suffixes are far more likely.
    raw = raw.replace(/[?#].*$/, "");
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* not percent-encoded — use as-is */
    }
  }
  if (raw === "~" || raw.startsWith("~/")) {
    raw = path.join(homedir(), raw.slice(1));
  }
  return path.resolve(getBaseDir(viewPath), raw);
}

// Images are fetched by the viewer page itself. `same-origin` is what a browser
// sends for that; `none` covers opening the URL directly, and an absent header
// covers non-browser clients — including the sibling MCP processes that push
// their renders here.
function isSameOriginFetch(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

function isLoopbackName(name: string): boolean {
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

// The port is well-known, so any page the user visits knows where to knock.
// Pinning the Host header is what closes DNS rebinding, which is the attack a
// fixed loopback port actually invites.
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return isLoopbackName(name);
}

// An absent Origin is a non-browser client — a sibling MCP process, or curl.
// Browsers always send one, and `null` is the opaque origin a sandboxed frame
// or a file:// page carries, which has no business reading these documents.
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    return isLoopbackName(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function buildApp(): express.Express {
  const app = express();
  const viewerPath = path.resolve(__dirname, "../src/viewer.html");

  // Guards every internal HTTP endpoint. The WebSocket upgrade never reaches
  // Express, so it carries its own copy of these checks — see attachWebSocket.
  app.use(INTERNAL_PREFIX, (req: Request, res: Response, next: NextFunction) => {
    if (!isSameOriginFetch(req) || !isLoopbackHost(req)) {
      res.status(403).type("text/plain").send("Cross-origin viewer requests are refused");
      return;
    }
    // A cross-origin <form> can only send simple content types, so demanding
    // JSON keeps the control endpoints out of reach without preflight.
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ error: "Control requests must be application/json" });
      return;
    }
    next();
  });

  app.get(IMAGE_ENDPOINT, async (req, res) => {
    const src = typeof req.query.src === "string" ? req.query.src : "";
    if (!src) {
      res.status(400).type("text/plain").send("Missing src");
      return;
    }
    const from = typeof req.query.from === "string" ? req.query.from : "/";
    const filePath = resolveImagePath(src, from);

    const contentType = IMAGE_CONTENT_TYPES[path.extname(filePath).toLowerCase()];
    if (!contentType) {
      res.status(415).type("text/plain").send(`Not a supported image type: ${filePath}`);
      return;
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        res.status(404).type("text/plain").send(`Not a file: ${filePath}`);
        return;
      }
      if (info.size > MAX_IMAGE_BYTES) {
        res.status(413).type("text/plain").send(`Image too large: ${filePath}`);
        return;
      }
      // Images are read fresh every render so a regenerated chart or screenshot
      // shows up without a hard reload.
      res.type(contentType).set("Cache-Control", "no-store").send(await readFile(filePath));
    } catch {
      res.status(404).type("text/plain").send(`Image not found: ${filePath}`);
    }
  });

  // How a starting process tells a sibling viewer apart from an unrelated
  // program that happens to hold the port.
  app.get(HEALTH_ENDPOINT, (_req, res) => {
    // `version` is for whoever curls this while debugging a mixed-version set;
    // the election itself reads only `server` and `control`.
    res.json({ server: SERVER_ID, control: CONTROL_VERSION, version: VERSION });
  });

  app.post(RENDER_ENDPOINT, express.json({ limit: "64kb" }), async (req, res) => {
    const file = req.body?.file;
    if (typeof file !== "string" || !file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }
    const viewPath = normalizePath(
      typeof req.body?.path === "string" ? req.body.path : "/",
    );
    try {
      const result = await pushFile(file, viewPath);
      await openBrowser(viewPath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post(CLEAR_ENDPOINT, express.json({ limit: "8kb" }), (req, res) => {
    const raw = req.body?.path;
    clearLocal(raw === "*" ? "*" : normalizePath(typeof raw === "string" ? raw : "/"));
    res.json({ ok: true });
  });

  app.get(PATHS_ENDPOINT, (_req, res) => {
    res.json({ paths: listPaths() });
  });

  // The prefix is reserved, so anything else under it is an error rather than a
  // page — otherwise the catch-all would answer a health probe from a version
  // that predates it with the viewer HTML.
  app.all(`${INTERNAL_PREFIX}{/*rest}`, (_req, res) => {
    res.status(404).json({ error: "Unknown viewer endpoint" });
  });

  app.get("/{*path}", (_req, res) => {
    res.sendFile(viewerPath, { dotfiles: "allow" });
  });

  return app;
}

function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({
    server,
    // The upgrade bypasses Express entirely — `ws` listens on the raw server —
    // so the guards have to be repeated here. This socket is what carries the
    // rendered documents, which makes it the one that matters most.
    verifyClient: ({ req, origin }: { req: IncomingMessage; origin?: string }) =>
      isLoopbackHost(req) && isLoopbackOrigin(origin),
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "/", `http://localhost:${getPort()}`);
    const viewPath = normalizePath(url.searchParams.get("path") || "/");

    const clients = getClients(viewPath);
    clients.add(ws);

    const content = contentByPath.get(viewPath) || "";
    ws.send(JSON.stringify({ type: "render", content }));

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });
}

export function startWebServer(): Promise<void> {
  return join(buildApp, attachWebSocket);
}

// baseDir must be recorded before the broadcast: the page resolves its images
// the moment it receives the content.
export function pushContent(content: string, viewPath: string = "/", baseDir?: string): void {
  const p = normalizePath(viewPath);
  contentByPath.set(p, content);
  if (baseDir) {
    baseDirByPath.set(p, baseDir);
  } else {
    baseDirByPath.delete(p);
  }
  broadcast(p, { type: "render", content });
}

export async function pushFile(
  filePath: string,
  viewPath: string = "/",
): Promise<{ resolvedPath: string; bytes: number }> {
  const resolvedPath = path.resolve(filePath);
  const content = await readFile(resolvedPath, "utf8");
  // Relative image paths in a file are written relative to that file.
  pushContent(content, viewPath, path.dirname(resolvedPath));
  return { resolvedPath, bytes: Buffer.byteLength(content) };
}

export function clearContent(viewPath: string = "/"): void {
  const p = normalizePath(viewPath);
  contentByPath.set(p, "");
  broadcast(p, { type: "clear" });
}

function clearLocal(viewPath: string): void {
  if (viewPath === "*") {
    for (const p of listPaths()) clearContent(p);
    return;
  }
  clearContent(viewPath);
}

function hasLiveClients(viewPath: string): boolean {
  const clients = clientsByPath.get(viewPath);
  if (!clients) return false;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

// Whether a page is unattended. Asking the live sockets rather than a "have I
// opened this before" flag is what lets sessions share one tab per path — and
// it reopens a tab the user closed, which a flag never did.
export function shouldOpenBrowser(viewPath: string = "/"): boolean {
  return !hasLiveClients(normalizePath(viewPath));
}

export async function openBrowser(viewPath: string = "/"): Promise<void> {
  if (process.env.MDV_NO_OPEN) return;
  const p = normalizePath(viewPath);
  if (!shouldOpenBrowser(p)) return;

  // Just took the port over from a departed host: its pages are still out there
  // reconnecting, and opening now would put a second tab beside each of them.
  const settle = SETTLE_MS - hostUptimeMs();
  if (settle > 0) {
    await delay(settle);
    if (!shouldOpenBrowser(p)) return;
  }

  const attempted = openAttempts.get(p);
  if (attempted !== undefined && Date.now() - attempted < OPEN_GRACE_MS) return;
  openAttempts.set(p, Date.now());
  await open(viewerUrl(p));
}

export function viewerUrl(viewPath: string = "/"): string {
  const p = normalizePath(viewPath);
  return p === "/" ? `http://localhost:${getPort()}` : `http://localhost:${getPort()}${p}`;
}

export function listPaths(): string[] {
  return Array.from(contentByPath.keys()).filter((p) => contentByPath.get(p) !== "");
}

export async function renderFile(
  file: string,
  viewPath: string = "/",
): Promise<{ resolvedPath: string; bytes: number }> {
  const p = normalizePath(viewPath);
  // A relative path means something only in this process's working directory,
  // so it has to be resolved here rather than by the host.
  const absolute = path.resolve(file);
  return viaHost(
    () => control(RENDER_ENDPOINT, { file: absolute, path: p }),
    async () => {
      const result = await pushFile(absolute, p);
      await openBrowser(p);
      return result;
    },
  );
}

export async function clearViewer(viewPath: string = "/"): Promise<void> {
  const p = viewPath === "*" ? "*" : normalizePath(viewPath);
  await viaHost(
    () => control(CLEAR_ENDPOINT, { path: p }),
    async () => clearLocal(p),
  );
}

export async function activePaths(): Promise<string[]> {
  return viaHost(
    async () => (await control<{ paths?: string[] }>(PATHS_ENDPOINT)).paths ?? [],
    async () => listPaths(),
  );
}
