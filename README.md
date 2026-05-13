# Markdown Viewer MCP Server

An MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that renders markdown in a browser window with live updates. Supports Mermaid diagrams, KaTeX math, syntax-highlighted code blocks, tables, and GitHub-flavored markdown.

![screenshot](screenshot.png)

## Install

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

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

Or to a project-level `.mcp.json`:

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

## Interactive Q&A and Quote (1.2.0)

Highlight any text in the rendered document — a small popover appears with two actions:

- **💬 Ask** — type a question. It opens a thread in the viewer's side panel; Claude's answer renders back into that thread as full markdown (Mermaid, KaTeX, code highlighting included).
- **📎 Quote** — type an optional comment. The excerpt is dropped into Claude's next-turn context with no thread; Claude replies in chat instead of the viewer.

Tools the server exposes for this:

| Tool | Purpose |
| --- | --- |
| `get_pending_questions` | Drain unseen Q&A threads. Returns each `id`, highlighted text, and question. |
| `answer_question` | Post a markdown answer back to a thread by `id`. Renders live in the panel. |
| `get_pending_selections` | Drain context-only quotes (excerpt + optional comment). Do **not** answer these in the viewer. |

To make Claude check the viewer automatically, add a hint to your `CLAUDE.md` — e.g. *"if I mention questions in the viewer, call `get_pending_questions` first."*

## Getting Claude to use it automatically

Claude won't use the viewer unless you tell it to. Add something like this to your `CLAUDE.md` (global or project-level):

```markdown
## Markdown Viewer

When presenting plans, architecture designs, code reviews, or any structured analysis,
use the `render_markdown` tool to render it in the browser viewer. Don't wait to be
asked — render proactively whenever the output would benefit from rich formatting,
diagrams, or tables.

Use Mermaid diagrams liberally to visualize architectures, flows, data models, and
relationships. The viewer supports:
- Mermaid diagrams (flowcharts, sequence, ERD, Gantt, etc.)
- Syntax-highlighted code blocks
- KaTeX math ($inline$ and $$display$$)
- Tables, blockquotes, task lists
- Dark/light theme with font selection

Use `path` to organize content into separate tabs (e.g. `/plan`, `/review`, `/debug`).
```

## Install from source

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

## License

MIT
