import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import open from "open";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-path content and client tracking
const contentByPath = new Map<string, string>();
const clientsByPath = new Map<string, Set<WebSocket>>();
let serverPort = 0;
let httpServer: Server | undefined;
const openedPaths = new Set<string>();

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

export function startWebServer(): Promise<void> {
  const app = express();
  const viewerPath = path.resolve(__dirname, "../src/viewer.html");

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
    httpServer!.listen(0, () => {
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
  broadcast(p, { type: "render", content });
}

export async function pushFile(
  filePath: string,
  viewPath: string = "/",
): Promise<{ resolvedPath: string; bytes: number }> {
  const resolvedPath = path.resolve(filePath);
  const content = await readFile(resolvedPath, "utf8");
  pushContent(content, viewPath);
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

