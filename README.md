# Markdown Viewer MCP Server

An MCP server that renders markdown in a browser window with live updates via WebSocket. Supports Mermaid diagrams, KaTeX math, syntax-highlighted code blocks, and GitHub-flavored markdown.

![screenshot](https://github.com/user-attachments/assets/placeholder)

## Features

- **Live updates** — content is pushed to the browser in real-time over WebSocket
- **Mermaid diagrams** — flowcharts, sequence diagrams, ERDs, Gantt charts, and more
- **KaTeX math** — inline `$...$` and display `$$...$$` math rendering
- **Syntax highlighting** — automatic language detection with highlight.js
- **Multiple pages** — render to separate paths (`/plan`, `/review`, `/agent-1`), each in its own browser tab
- **Dark / light theme** — toggle in the status bar, persisted in localStorage
- **Font selection** — system, serif, or monospace
- **Copy buttons** — on every code block
- **Auto-reconnect** — exponential backoff if the connection drops

## Tools

| Tool | Description |
|------|-------------|
| `render_markdown` | Replace the viewer content with new markdown. Optionally specify a `path` and `title`. |
| `append_markdown` | Append markdown to the existing content on a page. |
| `clear_viewer` | Clear a page, or pass `*` to clear all pages. |
| `list_viewers` | List all active viewer pages that currently have content. |

## Setup

### Configure in Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "markdown-viewer": {
      "command": "npx",
      "args": ["-y", "mcp-markdown-viewer"]
    }
  }
}
```

The server picks a random available port on startup and opens browser tabs automatically when content is rendered.

### Install from source

If you prefer to run from a local checkout:

```bash
git clone https://github.com/Mykhol/markdown-mcp.git
cd markdown-mcp
npm install
npm run build
```

Then point your MCP config at the built file:

```json
{
  "mcpServers": {
    "markdown-viewer": {
      "command": "node",
      "args": ["/path/to/markdown-mcp/dist/server.js"]
    }
  }
}
```

## Usage

Once configured, the `render_markdown` tool is available to Claude. For example, you can ask Claude to:

- Render a plan or architecture diagram
- Display a code review with syntax highlighting
- Show a Mermaid flowchart of a system's data flow
- Present a table comparing options

Each call to `render_markdown` replaces the content on that path. Use `append_markdown` to add to existing content, or `clear_viewer` to reset.

### Multiple pages

Use the `path` parameter to organize content into separate tabs:

```
render_markdown(content: "# Plan\n...", path: "/plan")
render_markdown(content: "# Review\n...", path: "/review")
```

## Development

```bash
npm run dev    # watch mode — recompiles on changes
npm start      # run the server directly
```

## License

MIT
