import type { Plugin } from 'vite';
import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { constants } from 'node:fs';
import type { ServerResponse } from 'node:http';

interface ApiOptions {
	ticketsDir: string;
	siblingDir?: string;
	siblingPort?: number;
}

const STAGES = ['fix', 'plan', 'implement', 'review', 'blocked', 'complete'] as const;

function json(res: ServerResponse, data: unknown, status = 200) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

async function dirExists(path: string): Promise<boolean> {
	try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function parseFilename(filename: string): { priority: number; slug: string } {
	const match = filename.replace(/\.md$/, '').match(/^(\d+(?:\.\d+)?)-(.+)$/);
	if (!match) return { priority: 0, slug: filename.replace(/\.md$/, '') };
	return { priority: parseFloat(match[1]), slug: match[2] };
}

function parseTicketMeta(content: string): { meta: Record<string, string | string[]>; body: string } {
	const sepIdx = content.indexOf('----');
	if (sepIdx === -1) return { meta: {}, body: content.trim() };

	const header = content.slice(0, sepIdx);
	const body = content.slice(sepIdx + 4).trim();
	const meta: Record<string, string | string[]> = {};

	let currentKey = '';
	let listValues: string[] = [];
	let inList = false;

	for (const line of header.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (trimmed.startsWith('- ') && inList) {
			listValues.push(trimmed.slice(2).trim());
			continue;
		}

		if (inList && currentKey) {
			meta[currentKey] = listValues.length === 1 ? listValues[0] : listValues;
			inList = false;
			listValues = [];
		}

		const colonIdx = trimmed.indexOf(':');
		if (colonIdx === -1) continue;

		currentKey = trimmed.slice(0, colonIdx).trim();
		const val = trimmed.slice(colonIdx + 1).trim();

		if (val) {
			if (val.includes(',')) {
				meta[currentKey] = val.split(',').map(s => s.trim());
			} else {
				meta[currentKey] = val;
			}
		} else {
			inList = true;
			listValues = [];
		}
	}

	if (inList && currentKey) {
		meta[currentKey] = listValues.length === 1 ? listValues[0] : listValues;
	}

	return { meta, body };
}

async function listMdFiles(dir: string): Promise<string[]> {
	try {
		const files = await readdir(dir);
		return files.filter(f => f.endsWith('.md') && f !== 'AGENTS.md' && f !== 'CLAUDE.md').sort();
	} catch { return []; }
}

export function tessApi(opts: ApiOptions): Plugin {
	const { ticketsDir, siblingDir } = opts;
	const siblingPort = opts.siblingPort ?? 3003;

	async function getPipeline() {
		const counts: Record<string, number> = {};
		for (const stage of STAGES) {
			counts[stage] = (await listMdFiles(join(ticketsDir, stage))).length;
		}
		return counts;
	}

	async function getStage(stage: string) {
		const dir = join(ticketsDir, stage);
		const files = await listMdFiles(dir);
		return Promise.all(files.map(async filename => {
			const content = await readFile(join(dir, filename), 'utf-8');
			const { meta } = parseTicketMeta(content);
			const { priority, slug } = parseFilename(filename);
			const files = meta.files
				? (Array.isArray(meta.files) ? meta.files : [meta.files])
				: undefined;
			return {
				filename,
				stage,
				priority,
				slug,
				description: (meta.description as string) ?? slug,
				dependencies: (meta.dependencies as string) ?? undefined,
				files,
			};
		}));
	}

	async function getTicket(stage: string, filename: string) {
		const filepath = join(ticketsDir, stage, filename);
		const raw = await readFile(filepath, 'utf-8');
		const { meta, body } = parseTicketMeta(raw);
		const { priority, slug } = parseFilename(filename);
		const files = meta.files
			? (Array.isArray(meta.files) ? meta.files : [meta.files])
			: undefined;
		return {
			filename,
			stage,
			priority,
			slug,
			description: (meta.description as string) ?? slug,
			dependencies: (meta.dependencies as string) ?? undefined,
			files,
			body,
			raw,
		};
	}

	async function getSibling() {
		if (!siblingDir || !await dirExists(siblingDir)) return null;
		return { name: 'teamos', url: `http://localhost:${siblingPort}` };
	}

	return {
		name: 'tess-api',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (!req.url?.startsWith('/api/')) return next();

				const url = new URL(req.url, `http://${req.headers.host}`);
				const path = url.pathname;

				try {
					if (path === '/api/pipeline') {
						return json(res, await getPipeline());
					}

					if (path === '/api/sibling') {
						return json(res, await getSibling());
					}

					let match = path.match(/^\/api\/stages\/([^/]+)$/);
					if (match) {
						const stage = decodeURIComponent(match[1]);
						if (!STAGES.includes(stage as typeof STAGES[number])) {
							return json(res, { error: 'Invalid stage' }, 400);
						}
						const tickets = await getStage(stage);
						tickets.sort((a, b) => b.priority - a.priority);
						return json(res, tickets);
					}

					match = path.match(/^\/api\/tickets\/([^/]+)\/([^/]+)$/);
					if (match) {
						const stage = decodeURIComponent(match[1]);
						const filename = decodeURIComponent(match[2]);
						return json(res, await getTicket(stage, filename));
					}

					json(res, { error: 'Not found' }, 404);
				} catch (err: any) {
					console.error('[tess-api]', err);
					json(res, { error: err.message }, 500);
				}
			});
		},
	};
}
