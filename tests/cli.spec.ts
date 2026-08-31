// The CLI is the viewer without MCP: it joins the same port election and talks
// to the same control endpoints. What is different is the process shape — a
// one-shot command that leaves a detached host behind — and that is what this
// suite exercises. A port of its own, because the commands here start and stop
// a real viewer and must not touch the developer's running one.
import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(repoRoot, "dist", "cli.js");

test.describe.configure({ mode: "serial" });

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = execFile(
      process.execPath,
      [join(repoRoot, "dist", "cli.js"), ...args],
      { encoding: "utf8" },
      (err, stdout, stderr) => {
        resolveRun({ code: child.exitCode, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

let port: number;
let workdir: string;

test.beforeAll(async () => {
  port = await freePort();
  process.env.MDV_PORT = String(port);
  process.env.MDV_NO_OPEN = "1";
  workdir = await mkdtemp(join(tmpdir(), "mdv-cli-"));
  await writeFile(join(workdir, "doc.md"), "# CLI\n\nRendered by the command line.\n");
});

test.afterAll(async () => {
  // Whatever state the serial suite left behind, the developer's viewer on the
  // default port is not this one, so ending this one is safe.
  await run(["stop"]);
  await rm(workdir, { recursive: true, force: true });
});

test("render starts a detached viewer and reports the page URL", async () => {
  const result = await run(["render", join(workdir, "doc.md")]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`http://localhost:${port}`);
});

test("list reports the page the render left behind", async () => {
  const listed = await run(["list"]);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("Active viewer pages");
  expect(listed.stdout).toContain(`http://localhost:${port}`);
});

test("stdin renders through '-'", async () => {
  const result = await run(["render", "-", "--path", "/piped"], "# Piped\n");
  expect(result.code).toBe(0);
  const listed = await run(["list"]);
  expect(listed.stdout).toContain("/piped");
});

test("clear drops the page it is given and only that page", async () => {
  const cleared = await run(["clear", "/piped"]);
  expect(cleared.code).toBe(0);
  const listed = await run(["list"]);
  expect(listed.stdout).not.toContain("/piped");
  expect(listed.stdout).toContain(`http://localhost:${port}`);
});

test("stop ends the viewer, and list then finds nothing", async () => {
  const stopped = await run(["stop"]);
  expect(stopped.code).toBe(0);
  expect(stopped.stdout).toContain(`Stopped the viewer on port ${port}`);
  const listed = await run(["list"]);
  expect(listed.stdout).toContain("No viewer running");
});

test("render starts a viewer again after one is stopped", async () => {
  const again = await run(["render", join(workdir, "doc.md")]);
  expect(again.code).toBe(0);
  const listed = await run(["list"]);
  expect(listed.stdout).toContain(`http://localhost:${port}`);
});
