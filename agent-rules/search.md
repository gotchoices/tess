## Code search (tess)

This repo has a local code-aware index wired to `mcp__code-search__*`. Prefer it over `grep`/`Glob`/`Read` for codebase questions — but pick the right sub-tool, because they are not interchangeable.

**Decision rule:**

- Query is identifier-shaped (any single symbol, camelCase, snake_case, or a list of names like `fooBar bazQux`)? → `find_references`.
- Query is prose ("where do we evict pages", "what handles JWT refresh", you don't yet know the identifier)? → `search_code`.

`search_code` embeds the query as natural language, so a bag of identifiers collapses to noise (negative cosine, "weak top" warning). Phrase semantic queries as questions or descriptions, not as identifier lists. If `search_code` returns a weak-top warning, treat the hits as noise — switch to `find_references` or rephrase, do **not** trust the relative-percentage ranking on noisy results.

**Tools:**

- `search_code(query, k?, path_filter?)` — semantic search. Scores are relative within each result set, not absolute. `k` defaults to 10 (max 50). `path_filter` is a SQL LIKE pattern, e.g. `"packages/lamina/%"`.
- `find_references(symbol, max?, path_filter?)` — literal substring; `|` ORs alternatives (`Foo|Bar`). Returns every hit (capped by `max`, default 50, max 500). This is the indexed replacement for `grep` on identifiers.
- `read_chunk(path, start_line, end_line)` — expand a snippet from either tool without a separate `Read`.

**Fallbacks:**

- Use `grep`/`Glob` only for filename patterns, regex with anchors/lookarounds, or when you need *every* literal hit (the index is chunk-granular and may miss adjacent matches inside one chunk).
- Never fall back to `grep` when `find_references` would suffice — it's strictly slower and pulls more bytes.
