## Code search (tess)

This repo has a local code-aware index wired to `mcp__code-search__*`. Prefer it over `grep`/`Glob`/`Read` for any codebase question.

- `search_code(query, k?, path_filter?)` — semantic search. Use it whenever you want to understand something, even when you already know the identifier. Scores are relative within each result set, not absolute.
- `find_references(symbol, max?, path_filter?)` — literal-substring search. `|`-separated alternatives are OR-ed (`Foo|Bar`). Use when you have an exact name and want every hit.
- `read_chunk(path, start_line, end_line)` — expand a snippet from either tool without a separate `Read`.

Fall back to `grep`/`Glob` only for filename patterns, regex with anchors/lookarounds, or when you need *every* literal hit (the index is chunk-granular).

Refresh: `node tess/scripts/index.mjs` (incremental) or `--rebuild`.
