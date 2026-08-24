import { test, expect } from "@playwright/test";
import WSPkg from "ws";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(repoRoot, "dist", "server.js");

const WSClient = WSPkg as unknown as typeof import("ws").WebSocket;
type WSClient = InstanceType<typeof WSClient>;

test.describe.configure({ mode: "serial" });

// A port nothing else is using, so the suite never collides with the shared
// viewer a developer has running on the real default.
function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

// A minimal MCP stdio client — enough to initialize and call tools. The server
// logs to stderr, so stdout carries nothing but newline-delimited JSON-RPC.
class ViewerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (value: unknown) => void>();
  // Recorded once, so stopping an already-dead process doesn't wait forever for
  // an `exit` that has already fired.
  private readonly exited: Promise<void>;

  constructor(port: number) {
    this.child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, MDV_PORT: String(port), MDV_NO_OPEN: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString()));
    this.exited = new Promise((done) => this.child.once("exit", () => done()));
  }

  private consume(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; result?: unknown };
      if (message.id === undefined) continue;
      const settle = this.pending.get(message.id);
      if (settle) {
        this.pending.delete(message.id);
        settle(message.result);
      }
    }
  }

  private request(method: string, params?: object): Promise<any> {
    const id = this.nextId++;
    return new Promise((settle) => {
      this.pending.set(id, settle as (value: unknown) => void);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sharing-spec", version: "1" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async call(name: string, args: object = {}): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args });
    return result.content.map((c: { text: string }) => c.text).join("\n");
  }

  stop(): Promise<void> {
    this.child.kill("SIGKILL");
    return this.exited;
  }
}

// The viewer page reports what the server actually holds for a path, which is
// how a test asserts across process boundaries.
function readPath(port: number, viewPath: string): Promise<string> {
  return new Promise((settle, fail) => {
    const ws = new WSClient(`ws://127.0.0.1:${port}/?path=${encodeURIComponent(viewPath)}`);
    ws.once("message", (data) => {
      settle(JSON.parse(data.toString()).content ?? "");
      ws.close();
    });
    ws.once("error", fail);
  });
}

let port: number;
let dir: string;
let running: ViewerProcess[] = [];

test.beforeAll(async () => {
  port = await freePort();
  dir = await mkdtemp(join(tmpdir(), "mdv-sharing-"));
});

test.afterEach(async () => {
  await Promise.all(running.map((p) => p.stop()));
  running = [];
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function launch(): Promise<ViewerProcess> {
  const proc = new ViewerProcess(port);
  running.push(proc);
  await proc.start();
  return proc;
}

async function docWith(name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, body, "utf8");
  return file;
}

test("a second process shares the first one's port instead of taking its own", async () => {
  const first = await launch();
  const second = await launch();

  const doc = await docWith("first.md", "# from the first process\n");
  const rendered = await first.call("render_file", { file: doc, path: "/one" });
  expect(rendered).toContain(`http://localhost:${port}/one`);

  const other = await docWith("second.md", "# from the second process\n");
  const sharedRender = await second.call("render_file", { file: other, path: "/two" });
  expect(sharedRender).toContain(`http://localhost:${port}/two`);
});

test("content rendered by one process is served by the other's viewer", async () => {
  const host = await launch();
  const client = await launch();

  const doc = await docWith("shared.md", "# rendered by the client\n");
  await client.call("render_file", { file: doc, path: "/shared" });

  // Only the host holds a listening socket, so reading the port at all proves
  // the client's content crossed the process boundary.
  expect(await readPath(port, "/shared")).toBe("# rendered by the client\n");
  expect(await host.call("list_viewers")).toContain("/shared");
});

test("clear_viewer from one process clears a page rendered by another", async () => {
  const host = await launch();
  const client = await launch();

  const doc = await docWith("to-clear.md", "# temporary\n");
  await host.call("render_file", { file: doc, path: "/clear-me" });
  expect(await readPath(port, "/clear-me")).toBe("# temporary\n");

  await client.call("clear_viewer", { path: "/clear-me" });
  expect(await readPath(port, "/clear-me")).toBe("");
});

test("a client takes over the port when the host's session ends", async () => {
  const host = await launch();
  const client = await launch();

  const before = await docWith("before.md", "# before the handover\n");
  await client.call("render_file", { file: before, path: "/handover" });

  await host.stop();

  const after = await docWith("after.md", "# after the handover\n");
  const rendered = await client.call("render_file", { file: after, path: "/handover" });

  // Same URL, now served by the promoted client — which is what lets the
  // browser tab reconnect where it already is.
  expect(rendered).toContain(`http://localhost:${port}/handover`);
  expect(await readPath(port, "/handover")).toBe("# after the handover\n");
});

test("an open page follows the handover instead of dying with the host", async ({ page }) => {
  const host = await launch();
  const client = await launch();

  const before = await docWith("survive-before.md", "# before the handover\n");
  await client.call("render_file", { file: before, path: "/survive" });

  await page.goto(`http://127.0.0.1:${port}/survive`);
  await expect(page.locator("#content")).toContainText("before the handover");

  await host.stop();

  const after = await docWith("survive-after.md", "# after the handover\n");
  await client.call("render_file", { file: after, path: "/survive" });

  // Same tab, same URL, now fed by a different process — this is what makes the
  // stable port worth having.
  await expect(page.locator("#content")).toContainText("after the handover", {
    timeout: 15000,
  });
});

// `fetch` treats Host as a forbidden header and silently drops an override, so
// the rebinding case has to be posed with a raw request.
function statusWithHost(viewPath: string, host: string): Promise<number> {
  return new Promise((settle, fail) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: viewPath, headers: { Host: host } },
      (res) => {
        res.resume();
        settle(res.statusCode ?? 0);
      },
    );
    req.once("error", fail);
    req.end();
  });
}

test("a rebound Host header is refused", async () => {
  await launch();

  expect(await statusWithHost("/__mdv/health", "evil.example.com")).toBe(403);
  expect(await statusWithHost("/__mdv/health", `127.0.0.1:${port}`)).toBe(200);
});

test("an unknown internal endpoint 404s rather than serving the viewer page", async () => {
  await launch();

  const res = await fetch(`http://127.0.0.1:${port}/__mdv/nope`);
  expect(res.status).toBe(404);
});

test("health identifies the server so a stranger on the port is not mistaken for one", async () => {
  await launch();

  const res = await fetch(`http://127.0.0.1:${port}/__mdv/health`);
  expect(res.ok).toBe(true);
  expect(await res.json()).toMatchObject({ server: "mcp-markdown-viewer", control: 1 });
});

test("a control POST without a JSON content type is refused", async () => {
  await launch();

  const res = await fetch(`http://127.0.0.1:${port}/__mdv/clear`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "path=/",
  });
  expect(res.status).toBe(415);
});
