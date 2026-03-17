# @skele-crew/memory-server

Hardened fork of [@modelcontextprotocol/server-memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) — the persistent knowledge graph MCP server for skele-crew agents.

## What's different from upstream

| Hardening | Description |
|-----------|-------------|
| **Async mutex** | The entire read-modify-write cycle is serialised via `async-mutex`. Both writes *and* reads go through the lock, so no agent ever sees a partially-written graph. |
| **Atomic writes** | Saves go to a `.tmp` file then `fs.rename()` into place. A crash mid-write never leaves a corrupt file. |
| **Auto-repair on load** | Invalid JSON lines, schema-invalid records, and duplicate entries are all silently skipped or deduplicated on load. The server never crashes on a corrupted graph file. |
| **CWD-anchored default path** | The default graph path resolves to `<cwd>/memory/knowledge-graph.jsonl`, so all agent processes share the same graph regardless of where the package is installed. |
| **Safe legacy migration** | If `memory.json` exists but `knowledge-graph.jsonl` doesn't, the server migrates the data properly (validates each entry via Zod) rather than blindly renaming the file. |

## Setup

### 1. Build

```bash
cd mcp/memory-server
npm install
npm run build        # compiles TypeScript → dist/
```

The compiled entry point is `dist/index.js`.

### 2. Register in VS Code (for Copilot agents)

The server is already registered in `.vscode/mcp.json`. No extra steps required — VS Code will prompt for the `SENTRY_ACCESS_TOKEN` on first use of the Sentry MCP; the memory server has no secret inputs.

To override the graph file path, set `MEMORY_FILE_PATH` in the server's `env` block in `.vscode/mcp.json`:

```json
"env": {
  "MEMORY_FILE_PATH": "/absolute/path/to/your/knowledge-graph.jsonl"
}
```

A relative path is resolved from `process.cwd()` (the workspace root).

### 3. Run manually (debug / one-off)

```bash
# From repo root — the server reads memory/knowledge-graph.jsonl by default
node mcp/memory-server/dist/index.js
```

## Running tests

```bash
cd mcp/memory-server
npm test             # runs Vitest unit + hardening suites with coverage
```

### Test suites

| File | What it covers |
|------|---------------|
| `__tests__/knowledge-graph.test.ts` | CRUD operations, dedup, persistence, search, openNodes |
| `__tests__/hardening.test.ts` | Mutex concurrency, atomic writes, auto-repair, schema validation, legacy migration, default path |
| `tests/memory/test_server_integration.py` | Integration smoke tests — spawns compiled binary, exercises MCP protocol end-to-end |

## MCP tools exposed

| Tool | Description |
|------|-------------|
| `create_entities` | Create one or more entities |
| `create_relations` | Create relations between entities |
| `add_observations` | Append observations to an existing entity |
| `delete_entities` | Delete entities and cascade-delete their relations |
| `delete_observations` | Remove specific observations from an entity |
| `delete_relations` | Remove specific relations |
| `read_graph` | Return the full knowledge graph |
| `search_nodes` | Full-text search across entity names, types, and observations |
| `list_entities_by_prefix` | Return all entities whose name starts with a namespace prefix (e.g. `product:buzzy-game`) — name-only match, never matches observation text |
| `open_nodes` | Fetch specific entities by name |

## Knowledge graph file format

Each line in `memory/knowledge-graph.jsonl` is a self-contained JSON object:

```jsonl
{"type":"entity","name":"product:buzzy-game","entityType":"product","observations":["status: active"]}
{"type":"relation","from":"agent:coo","to":"product:buzzy-game","relationType":"owns"}
```

See `TEMPLATES.md` in the repo root for entity naming conventions and namespace prefixes.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_FILE_PATH` | `<cwd>/memory/knowledge-graph.jsonl` | Absolute or CWD-relative path to the graph file |
