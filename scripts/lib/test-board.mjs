/**
 * Temporary `tickets/` trees for tests.  There is no `.test.` in the name, so
 * `npm test` does not run this file as a suite of its own.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { RELEASES_FILE } from './releases.mjs';
import { TOMBSTONE_FILE } from './tombstones.mjs';

const tempDirs = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** Ticket text whose header holds `description: x` plus `lines`, e.g. `withHeader('prereq: a, b', 'target: GA')`. */
export function withHeader(...lines) {
	return ['description: x', ...lines, '----', 'body', ''].join('\n');
}

/**
 * A tickets/ tree, removed once the importing test file finishes.  No git:
 * prereq resolution and the board check read files, nothing else.
 *
 * `places` maps a stage folder — or a path under one, such as `backlog/GA` —
 * to its files, each a filename (given `withHeader()` content) or a
 * `[filename, content]` pair; an empty list just creates the directory.
 * `releases` is written verbatim to `releases.md` when given; `tombstones`
 * become ledger lines.
 */
export async function makeBoard(places = {}, { releases, tombstones = [] } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'tess-board-test-'));
	tempDirs.push(dir);
	const ticketsDir = join(dir, 'tickets');
	await mkdir(ticketsDir, { recursive: true });
	for (const [place, files] of Object.entries(places)) {
		await mkdir(join(ticketsDir, place), { recursive: true });
		for (const file of files) {
			const [name, content] = Array.isArray(file) ? file : [file, withHeader()];
			await writeFile(join(ticketsDir, place, name), content, 'utf-8');
		}
	}
	if (releases != null) await writeFile(join(ticketsDir, RELEASES_FILE), releases, 'utf-8');
	if (tombstones.length > 0) {
		await writeFile(join(ticketsDir, TOMBSTONE_FILE), tombstones.map(r => JSON.stringify(r) + '\n').join(''), 'utf-8');
	}
	return ticketsDir;
}
