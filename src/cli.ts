#!/usr/bin/env node
// The viewer from a shell, for agents and scripts that speak no MCP. Same
// shared port, same pages: the first command starts a detached host, and every
// command after that is a client pushing renders at whichever process owns it.
import { execFile, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLEAR_ENDPOINT,
  PATHS_ENDPOINT,
  RENDER_ENDPOINT,
  isSiblingViewer,
  preferredPort,
} from "./peer.js";
import { startWebServer } from "./web.js";
import { VERSION } from "./version.js";

const HELP = `mdv — render markdown in the browser viewer

Usage:
  mdv render <file> [--path <path>] [--no-open]   Render a file ('-' reads stdin)
  mdv list                                        List pages with content
  mdv clear [<path>|*]                            Clear one page, or all pages
  mdv serve                                       Hold the viewer open
  mdv stop                                        Stop the running viewer

The viewer is shared: one detached process owns port 7391 (MDV_PORT to change)
and every command is a client of it. The first 'mdv render' starts that process
if nothing holds the port; 'mdv stop' ends it. MDV_NO_OPEN=1 never launches a
browser — useful over SSH and in CI.

https://github.com/Mykhol/markdown-mcp`;

const RENDER_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 3000;
const POLL_MS = 100;

function usageError(message: string): never {
  console.error(`mdv: ${message}\nRun 'mdv --help' for usage.`);
  process.exit(2);
}

// The surface is four commands and two flags, so a hand-rolled parser beats a
// dependency the MCP server would never share.
function parseFlags(argv: string[]): { path: string | undefined; noOpen: boolean } {
  let path: string | undefined;
  let noOpen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path" || arg === "-p") {
      const value = argv[i + 1];
      if (value === undefined) usageError(`${arg} needs a path`);
      path = value;
      i++;
    } else if (arg === "--no-open") {
      noOpen = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      usageError(`Unknown flag: ${arg}`);
    }
  }
  return { path, noOpen };
}

// Positional arguments, with `--` separating a filename that starts with `-`.
// Values a value-taking flag already consumed are not positionals, which is
// what keeps `render - --path /piped` from seeing two of them.
function positionals(argv: string[]): string[] {
  const end = argv.indexOf("--");
  const scoped = end === -1 ? argv : argv.slice(0, end);
  const valueFlags = new Set(["--path", "-p"]);
  const out: string[] = [];
  for (let i = 0; i < scoped.length; i++) {
    const arg = scoped[i];
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") out.push(arg);
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(port: number, endpoint: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    ...init,
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const failure = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(failure.error || `Viewer returned ${res.status}`);
  }
  return (await res.json()) as T;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.once("error", reject);
    process.stdin.once("end", () => resolve(text));
  });
}

// The detached host is what makes one-shot commands possible: it stays alive
// after this process exits, so the page it rendered stays up with it.
function startDetachedServe(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "serve"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MDV_PORT: String(port) },
      },
    );
    const deadline = Date.now() + START_TIMEOUT_MS;
    const poll = (): void => {
      void (async () => {
        if (await isSiblingViewer(port)) {
          child.unref();
          resolve();
        } else if (child.exitCode !== null) {
          reject(new Error(`The viewer process exited before serving port ${port}.`));
        } else if (Date.now() > deadline) {
          child.kill();
          reject(new Error(`No viewer on port ${port} and starting one failed.`));
        } else {
          setTimeout(poll, POLL_MS);
        }
      })();
    };
    poll();
  });
}

// Resolves to the port of a running viewer, or null when `start` is false and
// none is up. Only commands that put content somewhere may start one.
function resolveViewer(start: true): Promise<number>;
function resolveViewer(start: false): Promise<number | null>;
async function resolveViewer(start: boolean): Promise<number | null> {
  const port = preferredPort();
  if (port === null) {
    throw new Error(
      "MDV_PORT=0 keeps the viewer private to one process, which a one-shot command cannot then find. Unset it or give it a port number.",
    );
  }
  if (await isSiblingViewer(port)) return port;
  if (!start) return null;
  await startDetachedServe(port);
  return port;
}

async function pushRender(
  port: number,
  absolutePath: string,
  viewPath: string,
  openTab: boolean,
): Promise<void> {
  const result = await fetchJson<{ resolvedPath: string; bytes: number }>(
    port,
    RENDER_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: absolutePath, path: viewPath, open: openTab }),
    },
  );
  const url =
    viewPath === "/" ? `http://localhost:${port}/` : `http://localhost:${port}${viewPath}`;
  console.log(`Rendered ${result.resolvedPath} (${result.bytes} bytes) at ${url}`);
}

// stdin renders through a temp file in the working directory, so relative
// image paths resolve the way they would if the pipe had been a file. The host
// reads it off disk before answering, so removing it afterwards cannot race.
async function render(file: string, viewPath: string, openTab: boolean): Promise<void> {
  const port = await resolveViewer(true);
  if (file === "-") {
    const tmp = path.join(process.cwd(), `.mdv-stdin-${process.pid}.md`);
    await writeFile(tmp, await readStdin(), "utf8");
    try {
      await pushRender(port, tmp, viewPath, openTab);
    } finally {
      await rm(tmp, { force: true });
    }
    return;
  }
  await pushRender(port, path.resolve(file), viewPath, openTab);
}

async function listPages(): Promise<void> {
  const port = await resolveViewer(false);
  if (port === null) {
    console.log("No viewer running.");
    return;
  }
  const { paths } = await fetchJson<{ paths: string[] }>(port, PATHS_ENDPOINT);
  if (paths.length === 0) {
    console.log("No active viewer pages.");
    return;
  }
  const lines = paths.map((p) =>
    p === "/" ? `http://localhost:${port}` : `http://localhost:${port}${p}`,
  );
  console.log(`Active viewer pages:\n${lines.join("\n")}`);
}

async function clearPages(viewPath: string): Promise<void> {
  const port = await resolveViewer(false);
  if (port === null) {
    console.log("No viewer running.");
    return;
  }
  await fetchJson(port, CLEAR_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: viewPath }),
  });
  console.log(viewPath === "*" ? "All viewer pages cleared" : "Viewer cleared");
}

// The host owns the port, so the port owns the answer to "which process?".
// macOS and every common Linux ship lsof; where it is missing, saying so beats
// killing the wrong process.
function pidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile("lsof", ["-ti", `tcp:${port}`], (err, stdout) => {
      if (err) {
        reject(new Error(`Could not find the viewer process: ${err.message}`));
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      );
    });
  });
}

async function stop(): Promise<void> {
  const port = preferredPort();
  if (port === null) {
    throw new Error("MDV_PORT=0 starts no shared viewer, so there is nothing to stop.");
  }
  if (!(await isSiblingViewer(port))) {
    console.log(`No viewer running on port ${port}.`);
    return;
  }
  // The lsof list includes this process while its keep-alive socket to the
  // health check is still open; killing it would be stopping the messenger.
  for (const pid of await pidsOnPort(port)) {
    if (pid !== process.pid) process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isSiblingViewer(port))) {
      console.log(`Stopped the viewer on port ${port}.`);
      return;
    }
    await delay(POLL_MS);
  }
  for (const pid of await pidsOnPort(port)) {
    if (pid === process.pid) continue;
    process.kill(pid, "SIGKILL");
  }
  console.log(`The viewer on port ${port} ignored SIGTERM and was killed.`);
}

// Holding the viewer open with no MCP session behind it. Client mode owns
// nothing — the sibling it joined serves the pages — so it exits rather than
// idling as a second process nobody can address.
async function serveCommand(): Promise<void> {
  const mode = await startWebServer();
  if (mode === "client") return;
  await new Promise(() => {});
}

function normalizePath(p: string | undefined): string {
  const raw = (p || "/").replace(/\/+$/, "") || "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.some((arg) => arg === "-h" || arg === "--help")) {
    console.log(HELP);
    return;
  }
  if (argv.some((arg) => arg === "-v" || arg === "--version")) {
    console.log(VERSION);
    return;
  }

  const [command, ...rest] = argv;

  if (command === "serve") {
    await serveCommand();
  } else if (command === "render") {
    const file = positionals(rest)[0];
    if (positionals(rest).length !== 1) usageError("render takes one file path, or '-' for stdin");
    const flags = parseFlags(rest);
    await render(file, flags.path || "/", !flags.noOpen);
  } else if (command === "list") {
    await listPages();
  } else if (command === "clear") {
    const targets = positionals(rest);
    if (targets.length > 1) usageError("clear takes at most one path");
    await clearPages(targets[0] === "*" ? "*" : normalizePath(targets[0]));
  } else if (command === "stop") {
    await stop();
  } else {
    usageError(`Unknown command: ${command ?? "(none)"}`);
  }
}

main().catch((err: Error) => {
  console.error(`mdv: ${err.message}`);
  process.exit(1);
});
