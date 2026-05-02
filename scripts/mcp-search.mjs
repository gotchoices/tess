#!/usr/bin/env node
/**
 * Tess code-search MCP server (stdio).
 *
 * Exposes three tools to the agent against the local sqlite-vec index built
 * by `tess/scripts/index.mjs`:
 *
 *   search_code({ query, k?, path_filter? })
 *     → top-k semantic matches with file/line/snippet/score.
 *
 *   find_references({ symbol, max?, path_filter? })
 *     → literal-string matches from the indexed corpus.
 *
 *   read_chunk({ path, start_line, end_line })
 *     → raw text of an arbitrary line range, sourced from disk so it can
 *       expand a snippet returned by search_code.
 *
 * The server refuses to start if no index exists; the error message points
 * at the indexer.
 */

// Critical: stdout is the MCP transport.  Any stray write breaks the JSON-RPC
// stream.  Send everything advisory to stderr.
const _origLog = console.log;
console.log = (...args) => console.error(...args);

import { join, resolve, isAbsolute, relative, sep, posix } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { IndexStore } from './lib/index-store.mjs';
import { Embedder, DEFAULT_MODEL, DEFAULT_DIM } from './lib/embedder.mjs';

function parseArgs(argv) {
	const opts = { repoRoot: process.cwd() };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--project' && argv[i + 1]) opts.repoRoot = resolve(argv[++i]);
	}
	if (process.env.TESS_PROJECT_ROOT) opts.repoRoot = resolve(process.env.TESS_PROJECT_ROOT);
	return opts;
}

const TOOLS = [
	{
		name: 'search_code',
		description: 'Semantic search over the project codebase. Returns ranked code snippets with file paths and line ranges. Best for "where is X used", "what handles Y", "find similar logic to Z" — questions where you do not know the exact identifier.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Natural-language description of what to find.' },
				k: { type: 'integer', description: 'Number of matches to return (default 10).', default: 10 },
				path_filter: { type: 'string', description: 'Optional SQL LIKE pattern restricting results to matching paths, e.g. "src/%".' },
			},
			required: ['query'],
		},
	},
	{
		name: 'find_references',
		description: 'Literal-string search over the indexed corpus. Use when you have an exact symbol name and want every occurrence.',
		inputSchema: {
			type: 'object',
			properties: {
				symbol: { type: 'string', description: 'Exact substring to find.' },
				max: { type: 'integer', description: 'Max matches to return (default 50).', default: 50 },
				path_filter: { type: 'string' },
			},
			required: ['symbol'],
		},
	},
	{
		name: 'read_chunk',
		description: 'Read a specific line range from a tracked file. Use to expand a snippet returned by search_code.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Project-relative or absolute file path.' },
				start_line: { type: 'integer', description: '1-based start line (inclusive).' },
				end_line: { type: 'integer', description: '1-based end line (inclusive).' },
			},
			required: ['path', 'start_line', 'end_line'],
		},
	},
];

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const indexDir = join(opts.repoRoot, 'tickets', '.index');
	const dbPath = join(indexDir, 'index.db');
	const modelCacheDir = join(indexDir, 'models');

	try { await access(dbPath, constants.R_OK); }
	catch {
		console.error(
			`tess-mcp-search: no index at ${dbPath}\n` +
			`Run:  node tess/scripts/index.mjs\n` +
			`from your project root to build it.`,
		);
		process.exit(1);
	}

	const store = await IndexStore.open(dbPath, { dim: DEFAULT_DIM, modelId: DEFAULT_MODEL, readonly: true });

	let embedder = null;
	const ensureEmbedder = async () => {
		if (!embedder) embedder = await Embedder.load(modelCacheDir, store.getMeta('model_id') ?? DEFAULT_MODEL);
		return embedder;
	};

	const server = new Server(
		{ name: 'code-search', version: '0.1.0' },
		{
			capabilities: { tools: {} },
			instructions: [
				'Local semantic + literal search over the project codebase, backed by a',
				'sqlite-vec index built by tess.  This server does NOT search tess tickets,',
				'docs, or chat history — it searches the source files of the host project.',
				'',
				'Use `search_code` for natural-language questions where you do not yet know',
				'the right identifier ("where do we handle JWT refresh", "what enforces',
				'page-cache eviction").  Use `find_references` once you have an exact name.',
				'Use `read_chunk` to expand a snippet returned by either tool.',
				'',
				'Prefer these tools over grep/Glob for exploratory questions about the',
				'codebase; fall back to grep/Glob for exact-string and filename-pattern',
				'lookups.',
			].join('\n'),
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		try {
			if (name === 'search_code') return await handleSearch(args, store, await ensureEmbedder());
			if (name === 'find_references') return handleReferences(args, store);
			if (name === 'read_chunk') return await handleReadChunk(args, opts.repoRoot);
			throw new Error(`unknown tool: ${name}`);
		} catch (err) {
			return {
				isError: true,
				content: [{ type: 'text', text: `error: ${err.message}` }],
			};
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`code-search ready (index: ${dbPath})`);
}

async function handleSearch(args, store, embedder) {
	const query = String(args.query ?? '').trim();
	if (!query) throw new Error('query is required');
	const k = Math.max(1, Math.min(50, Number(args.k ?? 10)));
	const pathFilter = args.path_filter ? String(args.path_filter) : null;

	const [embedding] = await embedder.embed([query]);
	const matches = store.knn(embedding, k, pathFilter);
	return {
		content: [{
			type: 'text',
			text: formatMatches(matches),
		}],
	};
}

function handleReferences(args, store) {
	const symbol = String(args.symbol ?? '');
	if (!symbol) throw new Error('symbol is required');
	const max = Math.max(1, Math.min(500, Number(args.max ?? 50)));
	const pathFilter = args.path_filter ? String(args.path_filter) : null;
	const rows = store.grepLiteral(symbol, max, pathFilter);
	return {
		content: [{
			type: 'text',
			text: rows.length === 0
				? `No matches for "${symbol}".`
				: rows.map(r => `${r.path}:${r.start_line}-${r.end_line}\n${trimSnippet(r.text)}`).join('\n\n---\n\n'),
		}],
	};
}

async function handleReadChunk(args, repoRoot) {
	const reqPath = String(args.path ?? '');
	if (!reqPath) throw new Error('path is required');
	const start = Math.max(1, Number(args.start_line ?? 1));
	const end = Math.max(start, Number(args.end_line ?? start));

	const abs = isAbsolute(reqPath) ? reqPath : join(repoRoot, reqPath);
	const rel = relative(repoRoot, resolve(abs));
	if (rel.startsWith('..')) throw new Error('path escapes project root');

	const text = await readFile(abs, 'utf-8');
	const lines = text.split(/\r?\n/);
	const slice = lines.slice(start - 1, end);
	const normalized = rel.split(sep).join(posix.sep);
	return {
		content: [{
			type: 'text',
			text: `${normalized}:${start}-${start + slice.length - 1}\n${slice.join('\n')}`,
		}],
	};
}

function formatMatches(matches) {
	if (matches.length === 0) return 'No matches.';
	return matches.map((m, i) => {
		const score = m.score.toFixed(3);
		return `[${i + 1}] ${m.path}:${m.start_line}-${m.end_line}  (score ${score})\n${trimSnippet(m.text)}`;
	}).join('\n\n---\n\n');
}

function trimSnippet(text) {
	const lines = text.split('\n');
	if (lines.length <= 60) return text;
	return lines.slice(0, 60).join('\n') + `\n… (${lines.length - 60} more line(s))`;
}

main().catch(err => { console.error(err); process.exit(1); });
