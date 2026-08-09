import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import open from "open";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-path content and client tracking
const contentByPath = new Map<string, string>();
const clientsByPath = new Map<string, Set<WebSocket>>();
// Directory that relative image paths in each page's markdown resolve against:
// the file's own directory for render_file, the server's cwd otherwise.
const baseDirByPath = new Map<string, string>();
let serverPort = 0;
let httpServer: Server | undefined;
const openedPaths = new Set<string>();

// Reserved prefix for the viewer's own endpoints, so it can never collide with
// a user-chosen view path.
const INTERNAL_PREFIX = "/__mdv";
export const IMAGE_ENDPOINT = `${INTERNAL_PREFIX}/image`;

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
// covers non-browser clients. Anything else is another site probing the port.
function isSameOriginFetch(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

export function startWebServer(): Promise<void> {
  const app = express();
  const viewerPath = path.resolve(__dirname, "../src/viewer.html");

  // Must precede the catch-all, which answers every other path with the viewer.
  app.get(IMAGE_ENDPOINT, async (req, res) => {
    if (!isSameOriginFetch(req)) {
      res.status(403).type("text/plain").send("Cross-origin image reads are refused");
      return;
    }

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

  app.get("/{*path}", (_req, res) => {
    res.sendFile(viewerPath, { dotfiles: "allow" });
  });

  httpServer = createServer(app);

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "/", `http://localhost:${serverPort}`);
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

  return new Promise((resolve) => {
    // Loopback only — the image endpoint reads local files, so the server has
    // no business being reachable from the rest of the network.
    httpServer!.listen(0, "127.0.0.1", () => {
      const addr = httpServer!.address();
      serverPort = typeof addr === "object" && addr ? addr.port : 0;
      console.error(`Markdown viewer running at http://localhost:${serverPort}`);
      resolve();
    });
  });
}

export function pushContent(content: string, viewPath: string = "/"): void {
  const p = normalizePath(viewPath);
  contentByPath.set(p, content);
  baseDirByPath.delete(p);
  broadcast(p, { type: "render", content });
}

export function appendContent(content: string, viewPath: string = "/"): void {
  const p = normalizePath(viewPath);
  const current = contentByPath.get(p) || "";
  contentByPath.set(p, current + content);
  broadcast(p, { type: "append", content });
}

export async function pushFile(
  filePath: string,
  viewPath: string = "/",
): Promise<{ resolvedPath: string; bytes: number }> {
  const resolvedPath = path.resolve(filePath);
  const content = await readFile(resolvedPath, "utf8");
  pushContent(content, viewPath);
  // Relative image paths in a file are written relative to that file.
  baseDirByPath.set(normalizePath(viewPath), path.dirname(resolvedPath));
  return { resolvedPath, bytes: Buffer.byteLength(content) };
}

export function clearContent(viewPath: string = "/"): void {
  const p = normalizePath(viewPath);
  contentByPath.set(p, "");
  broadcast(p, { type: "clear" });
}

export async function openBrowser(viewPath: string = "/"): Promise<void> {
  const p = normalizePath(viewPath);
  if (openedPaths.has(p)) return;
  openedPaths.add(p);
  const url = p === "/" ? `http://localhost:${serverPort}` : `http://localhost:${serverPort}${p}`;
  await open(url);
}

export function getPort(): number {
  return serverPort;
}

export function listPaths(): string[] {
  return Array.from(contentByPath.keys()).filter((p) => contentByPath.get(p) !== "");
}

