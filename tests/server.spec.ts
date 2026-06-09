import { test, expect } from "@playwright/test";
import WSPkg from "ws";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startWebServer,
  pushContent,
  appendContent,
  clearContent,
  pushFile,
  getPort,
  listPaths,
} from "../dist/web.js";

const WSClient = WSPkg as unknown as typeof import("ws").WebSocket;
type WSClient = InstanceType<typeof WSClient>;

test.describe.configure({ mode: "serial" });

let wsBase: string;

test.beforeAll(async () => {
  await startWebServer();
  wsBase = `ws://localhost:${getPort()}`;
});

test.afterEach(() => {
  for (const p of listPaths()) clearContent(p);
});

// Connect and prime a one-message listener attached BEFORE the socket opens.
// The server pushes an initial render synchronously on connection, so the
// message can arrive before any listener attached after `open` resolves.
function connect(viewPath: string): { ws: WSClient; firstMessage: Promise<Message> } {
  const ws = new WSClient(`${wsBase}/?path=${encodeURIComponent(viewPath)}`);
  const firstMessage = new Promise<Message>((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
  return { ws, firstMessage };
}

function waitOpen(ws: WSClient): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function nextMessage(ws: WSClient): Promise<Message> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

type Message = { type: string; content?: string };

test("client receives empty initial render on connect", async () => {
  const { ws, firstMessage } = connect("/");
  expect(await firstMessage).toEqual({ type: "render", content: "" });
  ws.close();
});

test("pushContent broadcasts a render message", async () => {
  const { ws, firstMessage } = connect("/");
  await firstMessage; // initial empty render
  await waitOpen(ws);

  const pending = nextMessage(ws);
  pushContent("# Hello", "/");
  expect(await pending).toEqual({ type: "render", content: "# Hello" });
  ws.close();
});

test("appendContent sends an append message with only the delta", async () => {
  pushContent("first", "/");
  const { ws, firstMessage } = connect("/");
  expect(await firstMessage).toEqual({ type: "render", content: "first" });

  const pending = nextMessage(ws);
  appendContent(" second", "/");
  expect(await pending).toEqual({ type: "append", content: " second" });
  ws.close();
});

test("clearContent sends a clear message", async () => {
  pushContent("x", "/");
  const { ws, firstMessage } = connect("/");
  await firstMessage;

  const pending = nextMessage(ws);
  clearContent("/");
  expect(await pending).toEqual({ type: "clear" });
  ws.close();
});

test("a late-joining client gets the current snapshot", async () => {
  pushContent("# Already here", "/late");
  const { ws, firstMessage } = connect("/late");
  expect(await firstMessage).toEqual({ type: "render", content: "# Already here" });
  ws.close();
});

test("paths are isolated — pushing to one does not notify another", async () => {
  const a = connect("/foo");
  const b = connect("/bar");
  await a.firstMessage;
  await b.firstMessage;

  const aPending = nextMessage(a.ws);
  const bMessages: unknown[] = [];
  b.ws.on("message", (data) => bMessages.push(JSON.parse(data.toString())));

  pushContent("only foo", "/foo");
  expect(await aPending).toEqual({ type: "render", content: "only foo" });

  // Give /bar's socket a moment to (not) receive anything.
  await new Promise((r) => setTimeout(r, 100));
  expect(bMessages).toEqual([]);

  a.ws.close();
  b.ws.close();
});

test("listPaths returns only paths with non-empty content", () => {
  pushContent("a", "/one");
  pushContent("b", "/two");
  clearContent("/one");
  expect(listPaths().sort()).toEqual(["/two"]);
});

test("path normalization treats trailing slash as same path", async () => {
  // /foo and /foo/ should target the same content bucket.
  pushContent("# Same", "/normalize");
  const { ws, firstMessage } = connect("/normalize/");
  expect(await firstMessage).toEqual({ type: "render", content: "# Same" });
  ws.close();
});

test("pushFile rejects when the file does not exist", async () => {
  const missing = join(tmpdir(), "render-file-does-not-exist.md");
  await expect(pushFile(missing, "/")).rejects.toThrow();
});

test("pushFile renders the file's contents and reports its absolute path and size", async () => {
  const body = "# Report\n\nfrom a file";
  const filePath = join(tmpdir(), `render-file-meta-${Date.now()}.md`);
  await writeFile(filePath, body);
  try {
    const { ws, firstMessage } = connect("/file-meta");
    await firstMessage; // initial empty render
    await waitOpen(ws);

    const pending = nextMessage(ws);
    const result = await pushFile(filePath, "/file-meta");
    expect(await pending).toEqual({ type: "render", content: body });
    expect(result.resolvedPath).toBe(filePath);
    expect(result.bytes).toBe(Buffer.byteLength(body));
    ws.close();
  } finally {
    await unlink(filePath);
  }
});
