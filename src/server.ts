#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  startWebServer,
  clearContent,
  pushFile,
  openBrowser,
  getPort,
  listPaths,
} from "./web.js";

const server = new McpServer({
  name: "markdown-viewer",
  version: "1.4.0",
});

server.tool(
  "render_file",
  "Render a markdown file from the local filesystem in the browser viewer. Reads the file at call time and renders its current contents (Mermaid, KaTeX, syntax highlighting, tables, images, and full GitHub-flavored markdown). Images use standard markdown syntax and may point at local files — ![alt](./diagrams/flow.png) resolves against the rendered file's own directory, so a doc renders the way it reads on disk; absolute paths, ~/…, file:// URLs, http(s) URLs and data: URLs all work too. Use 'path' to render to a separate page/tab. Provide an absolute file path when possible; relative paths resolve against the server's working directory.",
  {
    file: z
      .string()
      .describe(
        "Path to the markdown file to render. Absolute paths are recommended; relative paths resolve against the server's working directory.",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "URL path for this viewer page (e.g. '/plan', '/review'). Different paths open separate browser tabs. Defaults to '/'.",
      ),
  },
  async ({ file, path }) => {
    const viewPath = path || "/";
    try {
      const { resolvedPath, bytes } = await pushFile(file, viewPath);
      await openBrowser(viewPath);
      const url =
        viewPath === "/"
          ? `http://localhost:${getPort()}`
          : `http://localhost:${getPort()}${viewPath}`;
      return {
        content: [
          {
            type: "text",
            text: `Rendered ${resolvedPath} (${bytes} bytes) in viewer at ${url}`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to render file: ${(err as Error).message}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "clear_viewer",
  "Clear all content from the markdown viewer.",
  {
    path: z
      .string()
      .optional()
      .describe(
        "URL path for the viewer page to clear. Defaults to '/'. Use '*' to clear all pages.",
      ),
  },
  async ({ path }) => {
    if (path === "*") {
      for (const p of listPaths()) {
        clearContent(p);
      }
      return {
        content: [{ type: "text", text: "All viewer pages cleared" }],
      };
    }
    clearContent(path || "/");
    return {
      content: [{ type: "text", text: "Viewer cleared" }],
    };
  },
);

server.tool(
  "list_viewers",
  "List all active viewer pages that currently have content.",
  {},
  async () => {
    const paths = listPaths();
    if (paths.length === 0) {
      return {
        content: [{ type: "text", text: "No active viewer pages" }],
      };
    }
    const lines = paths.map(
      (p) => `- http://localhost:${getPort()}${p === "/" ? "" : p}`,
    );
    return {
      content: [
        {
          type: "text",
          text: `Active viewer pages:\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

// Start the web server first (OS picks a free port)
await startWebServer();

// Then connect MCP over stdio
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("Markdown Viewer MCP server running");
