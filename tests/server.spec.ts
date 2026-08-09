import { test, expect } from "@playwright/test";
import WSPkg from "ws";
import { mkdtemp, rm, stat, writeFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startWebServer,
  pushContent,
  appendContent,
  clearContent,
  pushFile,
  getPort,
  getBaseDir,
  resolveImagePath,
  listPaths,
} from "../dist/web.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplePng = join(repoRoot, "screenshot.png");

const WSClient = WSPkg as unknown as typeof import("ws").WebSocket;
type WSClient = InstanceType<typeof WSClient>;

test.describe.configure({ mode: "serial" });

let wsBase: string;
let httpBase: string;

test.beforeAll(async () => {
  await startWebServer();
  // 127.0.0.1 rather than localhost: the server binds loopback IPv4 only, and
  // `localhost` can resolve to ::1 first.
  wsBase = `ws://127.0.0.1:${getPort()}`;
  httpBase = `http://127.0.0.1:${getPort()}`;
});

function imageUrl(src: string, from = "/"): string {
  return `${httpBase}/__mdv/image?src=${encodeURIComponent(src)}&from=${encodeURIComponent(from)}`;
}

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

test.describe("image serving", () => {
  test("serves a local image with its content type and no caching", async () => {
    const res = await fetch(imageUrl(samplePng));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.arrayBuffer()).byteLength).toBe((await stat(samplePng)).size);
  });

  test("refuses paths that are not image types, so it cannot serve arbitrary files", async () => {
    const res = await fetch(imageUrl(join(repoRoot, "package.json")));
    expect(res.status).toBe(415);
  });

  test("404s a missing image", async () => {
    const res = await fetch(imageUrl(join(tmpdir(), "definitely-not-here.png")));
    expect(res.status).toBe(404);
  });

  test("404s a directory", async () => {
    const res = await fetch(imageUrl(repoRoot));
    // A directory has no image extension, so the type gate rejects it first.
    expect([404, 415]).toContain(res.status);
  });

  test("refuses cross-site image reads", async () => {
    const res = await fetch(imageUrl(samplePng), {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  test("allows the viewer page's own same-origin reads", async () => {
    const res = await fetch(imageUrl(samplePng), {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  test("400s when src is missing", async () => {
    const res = await fetch(`${httpBase}/__mdv/image`);
    expect(res.status).toBe(400);
  });

  test("resolves a file:// src", async () => {
    const res = await fetch(imageUrl(`file://${samplePng}`));
    expect(res.status).toBe(200);
  });

  test("resolves a relative, percent-encoded src against the file's directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdv-img-"));
    await writeFile(
      join(dir, "my shot.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
    );
    const doc = join(dir, "doc.md");
    await writeFile(doc, "![x](<my shot.svg>)");
    try {
      await pushFile(doc, "/spaces");
      const res = await fetch(imageUrl("my%20shot.svg", "/spaces"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe("image path resolution", () => {
  test("relative paths resolve against the server cwd for pushed markdown", () => {
    pushContent("![x](shot.png)", "/cwd-base");
    expect(getBaseDir("/cwd-base")).toBe(process.cwd());
    expect(resolveImagePath("shot.png", "/cwd-base")).toBe(join(process.cwd(), "shot.png"));
  });

  test("relative paths resolve against the file's directory after pushFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdv-base-"));
    const doc = join(dir, "doc.md");
    await writeFile(doc, "![x](./img/shot.png)");
    try {
      await pushFile(doc, "/file-base");
      expect(getBaseDir("/file-base")).toBe(dir);
      expect(resolveImagePath("./img/shot.png", "/file-base")).toBe(join(dir, "img", "shot.png"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pushing plain markdown to a page resets a base dir left by pushFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdv-reset-"));
    const doc = join(dir, "doc.md");
    await writeFile(doc, "# doc");
    try {
      await pushFile(doc, "/reset-base");
      expect(getBaseDir("/reset-base")).toBe(dir);
      pushContent("# plain", "/reset-base");
      expect(getBaseDir("/reset-base")).toBe(process.cwd());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expands ~ to the home directory", () => {
    expect(resolveImagePath("~/pics/shot.png")).toBe(join(homedir(), "pics", "shot.png"));
  });

  test("absolute paths ignore the base dir", () => {
    expect(resolveImagePath("/tmp/a/shot.png", "/cwd-base")).toBe("/tmp/a/shot.png");
  });

  test("strips a query string from a plain path", () => {
    expect(resolveImagePath("/tmp/shot.png?v=2")).toBe("/tmp/shot.png");
  });
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
