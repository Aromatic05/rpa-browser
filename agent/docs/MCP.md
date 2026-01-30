# MCP Server (stdio)

## Run MCP server

```
pnpm -C agent mcp
```

This starts the MCP server over stdio. The MCP server runs the same Playwright runtime as the agent.

### Environment variables

- None required. (This MCP entrypoint does not use MCP_STDIO.)

## Run smoke client

```
pnpm -C agent mcp:smoke
```

The smoke client spawns the MCP server, calls `tools/list`, then runs `browser.goto` and `browser.snapshot` against `https://example.com`.

To request an accessibility scan instead of the basic snapshot, pass `includeA11y: true` (and optionally `maxNodes`).

## Example output

```
tools/list: {
  "tools": [
    { "name": "browser.goto", "description": "Navigate the current tab to a URL.", "inputSchema": {"type":"object","required":["tabToken","url"],"properties":{"tabToken":{"type":"string"},"url":{"type":"string"}},"additionalProperties":false} },
    { "name": "browser.snapshot", "description": "Return page metadata or run an a11y scan.", "inputSchema": {"type":"object","required":["tabToken"],"properties":{"tabToken":{"type":"string"},"includeA11y":{"type":"boolean"},"maxNodes":{"type":"integer","minimum":0}},"additionalProperties":false} },
    { "name": "browser.click", "description": "Click an element using a resolver-compatible target.", "inputSchema": {"type":"object","required":["tabToken","target"],"properties":{"tabToken":{"type":"string"},"target":{"type":"object","required":["selector"],"properties":{"selector":{"type":"string"},"frame":{"type":"string"},"locatorCandidates":{"type":"array","items":{"type":"object","required":["kind"],"properties":{"kind":{"type":"string"},"selector":{"type":"string"},"testId":{"type":"string"},"role":{"type":"string"},"name":{"type":"string"},"text":{"type":"string"},"exact":{"type":"boolean"},"note":{"type":"string"}},"additionalProperties":true}},"scopeHint":{"type":"string"}},"additionalProperties":true}},"additionalProperties":false} },
    { "name": "browser.type", "description": "Type text into an element using a resolver-compatible target.", "inputSchema": {"type":"object","required":["tabToken","target","text"],"properties":{"tabToken":{"type":"string"},"target":{"type":"object","required":["selector"],"properties":{"selector":{"type":"string"},"frame":{"type":"string"},"locatorCandidates":{"type":"array","items":{"type":"object","required":["kind"],"properties":{"kind":{"type":"string"},"selector":{"type":"string"},"testId":{"type":"string"},"role":{"type":"string"},"name":{"type":"string"},"text":{"type":"string"},"exact":{"type":"boolean"},"note":{"type":"string"}},"additionalProperties":true}},"scopeHint":{"type":"string"}},"additionalProperties":true},"text":{"type":"string"},"clearFirst":{"type":"boolean"}},"additionalProperties":false} }
  ]
}
browser.goto: {
  "ok": true,
  "tabToken": "mcp-smoke-tab",
  "data": {
    "pageUrl": "https://example.com/"
  }
}
browser.snapshot: {
  "ok": true,
  "tabToken": "mcp-smoke-tab",
  "data": {
    "url": "https://example.com/",
    "title": "Example Domain"
  }
}
```
