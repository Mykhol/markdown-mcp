import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import open from "open";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-path content and client tracking
const contentByPath = new Map<string, string>();
const clientsByPath = new Map<string, Set<WebSocket>>();
let serverPort = 0;
let httpServer: Server | undefined;
const openedPaths = new Set<string>();

export interface QAThread {
  id: number;
  path: string;
  selection: string;
  question: string;
  questionAt: number;
  answer?: string;
  answerAt?: number;
  seenByAssistant: boolean;
}

const threadsByPath = new Map<string, QAThread[]>();
let threadIdCounter = 0;

export interface PendingSelection {
  id: number;
  path: string;
  selection: string;
  comment: string;
  timestamp: number;
  seenByAssistant: boolean;
}

const pendingSelections: PendingSelection[] = [];
let selectionIdCounter = 0;

function getThreadsFor(viewPath: string): QAThread[] {
  let arr = threadsByPath.get(viewPath);
  if (!arr) {
    arr = [];
    threadsByPath.set(viewPath, arr);
  }
  return arr;
}

function publicThread(t: QAThread) {
  return {
    id: t.id,
    selection: t.selection,
    question: t.question,
    questionAt: t.questionAt,
    answer: t.answer,
    answerAt: t.answerAt,
  };
}

function broadcastThreads(viewPath: string): void {
  const threads = (threadsByPath.get(viewPath) || []).map(publicThread);
  broadcast(viewPath, { type: "threads", threads });
}

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

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/selections", (req, res) => {
    const targetRaw = typeof req.query.path === "string" ? req.query.path : undefined;
    const target = targetRaw ? normalizePath(targetRaw) : undefined;
    const selections = pendingSelections
      .filter((s) => !target || s.path === target)
      .map((s) => ({
        id: s.id,
        path: s.path,
        selection: s.selection,
        comment: s.comment,
        timestamp: s.timestamp,
        seenByAssistant: s.seenByAssistant,
      }));
    res.json({ selections });
  });

  app.get("/api/threads", (req, res) => {
    const targetRaw = typeof req.query.path === "string" ? req.query.path : undefined;
    const target = targetRaw ? normalizePath(targetRaw) : undefined;
    const out: Array<ReturnType<typeof publicThread> & { path: string }> = [];
    for (const [p, threads] of threadsByPath) {
      if (target && p !== target) continue;
      for (const t of threads) out.push({ ...publicThread(t), path: p });
    }
    res.json({ threads: out });
  });

  app.post("/api/answer", (req, res) => {
    const body = req.body as { id?: number; answer?: string } | undefined;
    if (!body || typeof body.id !== "number" || typeof body.answer !== "string") {
      res.status(400).json({ error: "id (number) and answer (string) are required" });
      return;
    }
    const thread = answerQuestion(body.id, body.answer);
    if (!thread) {
      res.status(404).json({ error: `No thread with id=${body.id}` });
      return;
    }
    res.json({ ok: true, id: thread.id, path: thread.path });
  });

  app.post("/api/quote", (req, res) => {
    const body = req.body as
      | { selection?: string; comment?: string; path?: string }
      | undefined;
    if (!body || typeof body.selection !== "string") {
      res.status(400).json({ error: "selection is required" });
      return;
    }
    const entry: PendingSelection = {
      id: ++selectionIdCounter,
      path: normalizePath(body.path || "/"),
      selection: body.selection,
      comment: typeof body.comment === "string" ? body.comment : "",
      timestamp: Date.now(),
      seenByAssistant: false,
    };
    pendingSelections.push(entry);
    res.json({ ok: true, id: entry.id });
  });

  app.post("/api/ask", (req, res) => {
    const body = req.body as
      | { selection?: string; question?: string; path?: string }
      | undefined;
    if (!body || typeof body.selection !== "string" || typeof body.question !== "string") {
      res.status(400).json({ error: "selection and question are required strings" });
      return;
    }
    const viewPath = normalizePath(body.path || "/");
    const thread: QAThread = {
      id: ++threadIdCounter,
      path: viewPath,
      selection: body.selection,
      question: body.question,
      questionAt: Date.now(),
      seenByAssistant: false,
    };
    getThreadsFor(viewPath).push(thread);
    broadcastThreads(viewPath);
    res.json({ ok: true, id: thread.id });
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
    const threads = (threadsByPath.get(viewPath) || []).map(publicThread);
    if (threads.length > 0) {
      ws.send(JSON.stringify({ type: "threads", threads }));
    }

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

export function appendContent(content: string, viewPath: string = "/"): void {
  const p = normalizePath(viewPath);
  const current = contentByPath.get(p) || "";
  contentByPath.set(p, current + content);
  broadcast(p, { type: "append", content });
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

export function drainPendingQuestions(viewPath?: string): QAThread[] {
  const target = viewPath ? normalizePath(viewPath) : undefined;
  const result: QAThread[] = [];
  for (const [p, threads] of threadsByPath) {
    if (target && p !== target) continue;
    for (const t of threads) {
      if (!t.seenByAssistant && !t.answer) {
        t.seenByAssistant = true;
        result.push(t);
      }
    }
  }
  return result;
}

export function clearThreads(viewPath?: string): void {
  if (!viewPath) {
    for (const p of threadsByPath.keys()) {
      threadsByPath.set(p, []);
      broadcastThreads(p);
    }
    return;
  }
  const target = normalizePath(viewPath);
  threadsByPath.set(target, []);
  broadcastThreads(target);
}

export function drainPendingSelections(viewPath?: string): PendingSelection[] {
  const target = viewPath ? normalizePath(viewPath) : undefined;
  const result: PendingSelection[] = [];
  for (const s of pendingSelections) {
    if (target && s.path !== target) continue;
    if (!s.seenByAssistant) {
      s.seenByAssistant = true;
      result.push(s);
    }
  }
  return result;
}

export function answerQuestion(id: number, answer: string): QAThread | null {
  for (const [p, threads] of threadsByPath) {
    const t = threads.find((x) => x.id === id);
    if (t) {
      t.answer = answer;
      t.answerAt = Date.now();
      broadcastThreads(p);
      return t;
    }
  }
  return null;
}

