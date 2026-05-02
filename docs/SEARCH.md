# Tess Local Code Search

Optional, opt-in. Builds a local vector index of your repository and exposes it to the agent via MCP. No API keys; runs offline after the first model download.

## Pieces

```
                      tracked files (git ls-files)
                                  │
                                  ▼
                   ┌─────────────────────────────┐
                   │   indexer (index.mjs)       │
                   │   chunk → embed → upsert    │
                   └──────────────┬──────────────┘
                                  ▼
                   ┌─────────────────────────────┐
                   │   tickets/.index/index.db   │
                   │   sqlite + sqlite-vec       │
                   └──────────────┬──────────────┘
                                  ▼
                   ┌─────────────────────────────┐
                   │   MCP server                │
                   │   (mcp-search.mjs, stdio)   │
                   │   search_code               │
                   │   find_references           │
                   │   read_chunk                │
                   └──────────────┬──────────────┘
                                  ▼
                            agent (claude/...)
```

## Storage layout

```
tickets/
├── .index/
│   ├── index.db             sqlite + sqlite-vec
│   └── models/              transformers.js cache (~80MB)
├── .logs/
└── ...
```

All artifacts are gitignored. To uninstall: `rm -rf tickets/.index/` and remove the `tess-search` entry from your agent's MCP config.

## Embedding model

Default: `Xenova/all-MiniLM-L6-v2` — 384-dim, ~80MB, fast on CPU.

The model id and embedding dimension are stored in the DB's `meta` table. If you swap models the indexer will refuse to open the existing DB and direct you to `--rebuild`. This prevents silent vector-space mixing.

## MCP tools

### `search_code`
```
{ query: string, k?: integer = 10, path_filter?: string }
```
Embeds the query, runs a vec0 KNN, returns ranked snippets. `path_filter` is a SQL LIKE pattern (e.g. `src/%`).

### `find_references`
```
{ symbol: string, max?: integer = 50, path_filter?: string }
```
Literal-substring search across indexed chunks. Use when you have an exact identifier.

### `read_chunk`
```
{ path: string, start_line: integer, end_line: integer }
```
Returns the raw text of a line range, sourced from disk. The path is resolved against the project root and rejected if it escapes the root.

## Refreshing

```bash
node tess/scripts/index.mjs                       # incremental
node tess/scripts/index.mjs --rebuild             # drop and rebuild
node tess/scripts/index.mjs --status              # counts + last refresh
node tess/scripts/index.mjs --watch               # debounced fs watcher
node tess/scripts/run.mjs --refresh-index ...     # incremental between every ticket
```

`--refresh-index` is a no-op when no index exists, so it is safe to leave on for projects that have not opted in.

## Per-agent config

`init.mjs --with-search --agent <name>` writes:

| Agent | File | Action |
|---|---|---|
| `claude` | `.mcp.json` (project root) | Merges `tess-search` into `mcpServers`. |
| `cursor` | `.cursor/mcp.json` | Merges `tess-search` into `mcpServers`. |
| `codex` | `.codex/mcp-tess.toml.sample` | Writes a sample TOML block to paste into `~/.codex/config.toml`. |
| `auggie` | — | No-op; auggie does not support MCP today. |

Existing entries in any of these files are preserved.

## Footprint

- **npm install** in `tess/`: ~150MB on disk (better-sqlite3 + sqlite-vec native binaries, transformers.js, MCP SDK).
- **First indexer run**: ~80MB model download into `tickets/.index/models/`.
- **DB size**: roughly 1KB/chunk; a 5k-file repo typically lands around 40–80MB.

## Limitations and future work

- **Chunking is line-window**, not language-aware. Adding tree-sitter would improve recall but pulls in per-language native deps; deferred.
- **No hybrid retrieval** (BM25 + vector). sqlite has FTS5; layering it on the same store is a small follow-up.
- **No automatic refresh** — must be invoked (manually, via `--watch`, or via runner `--refresh-index`).
- **Single embedding model** — switching requires `--rebuild`.
