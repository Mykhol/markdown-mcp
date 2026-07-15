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

## Getting Claude to use it automatically

Claude won't use the viewer unless you tell it to. Add something like this to your `CLAUDE.md` (global or project-level):

```markdown
## Markdown Viewer

When presenting plans, architecture designs, code reviews, or any structured analysis,
write the content to a markdown file first and then use the `render_file` tool to render
it in the browser viewer. The `render_file` tool takes a `file` path argument and an
optional `path` for the viewer tab. Don't wait to be asked — render proactively whenever
the output would benefit from rich formatting, diagrams, or tables.

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
