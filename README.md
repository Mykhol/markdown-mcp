# Markdown Viewer MCP Server

An MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that renders markdown in a browser window with live updates. Supports Mermaid diagrams, KaTeX math, syntax-highlighted code blocks, tables, images, and GitHub-flavored markdown.

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

The server picks a random available port on startup, binds to loopback only, and opens browser tabs automatically when content is rendered.

## Images

Standard markdown image syntax works, including local files — the server reads
them off disk and serves them to the page, since a browser can't load a
filesystem path from an `http://` document.

```markdown
![absolute](/Users/me/shots/dashboard.png)
![relative](./diagrams/flow.svg)
![home-relative](~/Desktop/screenshot.png)
![file url](file:///Users/me/shots/dashboard.png)
![remote](https://example.com/chart.png)
![inline](data:image/svg+xml;base64,...)
```

Relative paths resolve against **the rendered file's own directory**, so a doc
that references `./diagrams/flow.png` renders the way it reads on disk.

Behaviour worth knowing:

- An image that is a block of its own is centred, framed, and **click-to-zoom**
  (Escape or click to dismiss) — the 860px text column downscales most
  screenshots past readability. Inline images, like badges, are left alone.
- A path that doesn't resolve renders as a placeholder naming the path that
  failed, rather than a bare broken-image glyph.
- PDF export waits for images to decode before measuring the page, so exports
  aren't truncated.
- Images are served with `Cache-Control: no-store`, so re-rendering picks up a
  regenerated chart or screenshot without a hard reload.

Only image file types are served (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`,
`avif`, `bmp`, `ico`, `apng`, `tif`, `tiff`), up to 32MB, over loopback only,
and cross-site requests are refused. `/__mdv/*` is reserved for the viewer's own
endpoints and can't be used as a page path.

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
- Images, including local file paths — ![alt](/abs/path/shot.png)
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
