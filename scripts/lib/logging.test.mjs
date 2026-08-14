import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { groupPrefix, pruneOldLogs } from './logging.mjs';

test('groupPrefix groups recognized suffixes by shared prefix', () => {
	const prefix = 'my-ticket.implement.2026-01-01T00-00-00-000Z';
	assert.equal(groupPrefix(`${prefix}.log`), prefix);
	assert.equal(groupPrefix(`${prefix}.prompt.md`), prefix);
	assert.equal(groupPrefix(`${prefix}.budget-warning`), prefix);
});

test('groupPrefix falls back to the whole filename for unrecognized extensions', () => {
	assert.equal(groupPrefix('screenshot.png'), 'screenshot.png');
	assert.equal(groupPrefix('capture.json'), 'capture.json');
});

test('groupPrefix falls back to the whole filename for a bare suffix', () => {
	// Stripping would leave an empty prefix, which would pool every such file
	// into one group (and read as falsy to any caller checking the result).
	assert.equal(groupPrefix('.log'), '.log');
	assert.equal(groupPrefix('.prompt.md'), '.prompt.md');
});

const tempDirs = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function makeLogsDir() {
	const dir = await mkdtemp(join(tmpdir(), 'tess-logging-test-'));
	tempDirs.push(dir);
	return dir;
}

async function touch(dir, name, mtimeMs) {
	const path = join(dir, name);
	await writeFile(path, '');
	const seconds = mtimeMs / 1000;
	await utimes(path, seconds, seconds);
}

test('pruneOldLogs prunes a .log + .prompt.md + .budget-warning group together', async () => {
	const dir = await makeLogsDir();
	const oldMs = Date.now() - 20 * 24 * 60 * 60 * 1000; // older than 14-day cutoff
	const prefix = 'old-ticket.implement.2026-01-01T00-00-00-000Z';
	await touch(dir, `${prefix}.log`, oldMs);
	await touch(dir, `${prefix}.prompt.md`, oldMs);
	await touch(dir, `${prefix}.budget-warning`, oldMs);

	const result = await pruneOldLogs(dir);

	assert.equal(result.removedGroups, 1);
	assert.equal(result.removedFiles, 3);
	assert.deepEqual(await readdir(dir), []);
});

test('pruneOldLogs ages out an unrecognized-extension file on its own', async () => {
	const dir = await makeLogsDir();
	const oldMs = Date.now() - 20 * 24 * 60 * 60 * 1000;
	await touch(dir, 'stray-screenshot.png', oldMs);
	await touch(dir, 'recent-ticket.implement.2026-01-01T00-00-00-000Z.log', Date.now());

	const result = await pruneOldLogs(dir);

	assert.equal(result.removedGroups, 1);
	assert.equal(result.removedFiles, 1);
	const remaining = await readdir(dir);
	assert.deepEqual(remaining, ['recent-ticket.implement.2026-01-01T00-00-00-000Z.log']);
});

test('pruneOldLogs ignores subdirectories', async () => {
	const dir = await makeLogsDir();
	const oldMs = Date.now() - 20 * 24 * 60 * 60 * 1000;
	await mkdir(join(dir, 'nested-dir'));
	await utimes(join(dir, 'nested-dir'), oldMs / 1000, oldMs / 1000);

	const result = await pruneOldLogs(dir);

	// A directory can't be unlinked, so counting it as a removed group would lie.
	assert.equal(result.removedGroups, 0);
	assert.equal(result.removedFiles, 0);
	assert.deepEqual(await readdir(dir), ['nested-dir']);
});

test('pruneOldLogs caps recent groups at the retention count', async () => {
	const dir = await makeLogsDir();
	const now = Date.now();
	// 52 groups, all inside the age cutoff, newest first — only 50 may survive.
	for (let i = 0; i < 52; i++) {
		await touch(dir, `ticket-${String(i).padStart(2, '0')}.implement.log`, now - i * 60_000);
	}

	const result = await pruneOldLogs(dir);

	assert.equal(result.removedGroups, 2);
	assert.equal(result.removedFiles, 2);
	const remaining = await readdir(dir);
	assert.equal(remaining.length, 50);
	// The two oldest are the ones evicted.
	assert.ok(!remaining.includes('ticket-50.implement.log'));
	assert.ok(!remaining.includes('ticket-51.implement.log'));
});

test('pruneOldLogs protectedLog guards only its own group, not an unrelated singleton', async () => {
	const dir = await makeLogsDir();
	const oldMs = Date.now() - 20 * 24 * 60 * 60 * 1000;
	const protectedPrefix = 'in-flight-ticket.implement.2026-01-01T00-00-00-000Z';
	await touch(dir, `${protectedPrefix}.log`, oldMs);
	await touch(dir, 'unrelated-stray.png', oldMs);

	const result = await pruneOldLogs(dir, join(dir, `${protectedPrefix}.log`));

	assert.equal(result.removedGroups, 1);
	assert.equal(result.removedFiles, 1);
	const remaining = await readdir(dir);
	assert.deepEqual(remaining, [`${protectedPrefix}.log`]);
});
