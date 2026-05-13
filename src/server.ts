#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  startWebServer,
  pushContent,
  appendContent,
  clearContent,
  openBrowser,
  getPort,
  listPaths,
  drainPendingQuestions,
  drainPendingSelections,
  answerQuestion,
} from "./web.js";

const server = new McpServer({
  name: "markdown-viewer",
  version: "1.2.0",
});

server.tool(
  "render_markdown",
  "Render rich markdown in a browser viewer with live updates. Supports Mermaid diagrams (flowcharts, sequence diagrams, ERDs, Gantt charts via ```mermaid code blocks), syntax-highlighted code, KaTeX math, tables, and full GitHub-flavored markdown. Use Mermaid diagrams liberally to visualize architectures, flows, and relationships. Use 'path' to render to separate pages (e.g. /plan, /review, /agent-1) — each path opens its own browser tab.",
  {
    content: z.string().describe("Markdown content to render"),
    path: z
      .string()
      .optional()
      .describe(
        "URL path for this viewer page (e.g. '/plan', '/review'). Different paths open separate browser tabs. Defaults to '/'.",
      ),
    title: z.string().optional().describe("Optional title for the viewer tab"),
  },
  async ({ content, path }) => {
    const viewPath = path || "/";
    pushContent(content, viewPath);
    await openBrowser(viewPath);
    const url =
      viewPath === "/"
        ? `http://localhost:${getPort()}`
        : `http://localhost:${getPort()}${viewPath}`;
    return {
      content: [
        {
          type: "text",
          text: `Rendered markdown in viewer at ${url}`,
        },
      ],
    };
  },
);

server.tool(
  "append_markdown",
  "Append markdown content to the existing viewer content.",
  {
    content: z.string().describe("Markdown content to append"),
    path: z
      .string()
      .optional()
      .describe("URL path for the viewer page to append to. Defaults to '/'."),
  },
  async ({ content, path }) => {
    const viewPath = path || "/";
    appendContent(content, viewPath);
    await openBrowser(viewPath);
    return {
      content: [{ type: "text", text: "Appended content to viewer" }],
    };
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

server.tool(
  "get_pending_questions",
  "Retrieve questions the user submitted from the markdown viewer by selecting text and clicking 'Ask Claude'. Returns each thread's id, highlighted text, and question, then marks them as seen so they aren't returned again. After answering, call answer_question with the same id to render your reply back into the viewer. If nothing is pending, returns an empty list — don't fabricate questions.",
  {
    path: z
      .string()
      .optional()
      .describe(
        "Only drain questions from this viewer path (e.g. '/plan'). Omit to drain questions from all paths.",
      ),
  },
  async ({ path }) => {
    const questions = drainPendingQuestions(path);
    if (questions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: path
              ? `No pending questions for ${path}.`
              : "No pending questions from the viewer.",
          },
        ],
      };
    }
    const formatted = questions
      .map((q) => {
        const header = `### Question id=${q.id} (from ${q.path})`;
        const sel = `Highlighted text:\n> ${q.selection.replace(/\n/g, "\n> ")}`;
        const ask = `User asks: ${q.question}`;
        return `${header}\n\n${sel}\n\n${ask}`;
      })
      .join("\n\n---\n\n");
    return {
      content: [
        {
          type: "text",
          text: `${questions.length} pending question${questions.length === 1 ? "" : "s"} from the viewer. After answering, call answer_question with the matching id to render your reply in the viewer.\n\n${formatted}`,
        },
      ],
    };
  },
);

server.tool(
  "get_pending_selections",
  "Retrieve excerpts the user dropped into context by selecting text in the viewer and clicking 'Quote'. Each entry has the highlighted text plus an optional comment from the user. These are not threaded questions — DO NOT call answer_question for them. Use them as context for whatever the user is asking in chat. Returns an empty list if nothing is pending.",
  {
    path: z
      .string()
      .optional()
      .describe(
        "Only drain selections from this viewer path (e.g. '/plan'). Omit for all paths.",
      ),
  },
  async ({ path }) => {
    const selections = drainPendingSelections(path);
    if (selections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: path
              ? `No pending selections for ${path}.`
              : "No pending selections from the viewer.",
          },
        ],
      };
    }
    const formatted = selections
      .map((s) => {
        const header = `### Quote ${s.id} (from ${s.path})`;
        const sel = `Highlighted text:\n> ${s.selection.replace(/\n/g, "\n> ")}`;
        const cmt = s.comment ? `\n\nUser comment: ${s.comment}` : "";
        return `${header}\n\n${sel}${cmt}`;
      })
      .join("\n\n---\n\n");
    return {
      content: [
        {
          type: "text",
          text: `${selections.length} pending selection${selections.length === 1 ? "" : "s"} from the viewer (context only — do not call answer_question):\n\n${formatted}`,
        },
      ],
    };
  },
);

server.tool(
  "answer_question",
  "Post an answer to a viewer question retrieved via get_pending_questions. The answer is rendered as markdown in the viewer's Q&A panel, beneath the user's question. Use the exact `id` returned by get_pending_questions.",
  {
    id: z.number().int().describe("The thread id returned by get_pending_questions"),
    answer: z
      .string()
      .describe(
        "Your answer in markdown. Supports the same features as render_markdown (code, Mermaid, KaTeX, tables).",
      ),
  },
  async ({ id, answer }) => {
    const thread = answerQuestion(id, answer);
    if (!thread) {
      return {
        content: [
          {
            type: "text",
            text: `No question with id=${id} was found. It may have been cleared or the id may be wrong.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Answer posted to viewer at ${thread.path} (thread ${id}).`,
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
