import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBoard, readBoardContext, ticketProblems } from './board-check.mjs';
import { discoverTickets, indexAllTickets } from './tickets.mjs';
import { makeBoard, withHeader } from './test-board.mjs';

const RELEASES = '# Releases\n\n## BETA\n\n## GA\n\n## V2\n';

async function check(ticketsDir) {
	return checkBoard(ticketsDir, await readBoardContext(ticketsDir), await indexAllTickets(ticketsDir, { withPrereqs: true }));
}

// ── checkBoard ────────────────────────────────────────────────────────────

test('a backlog folder that is not a listed code is an error naming the folder and its ticket count', async () => {
	const ticketsDir = await makeBoard({ 'backlog/sanjay': ['a.md', 'b.md'], 'backlog/ops': ['c.md'], 'backlog/GA': ['d.md'] }, { releases: RELEASES });

	const { errors } = await check(ticketsDir);

	assert.deepEqual(errors, [
		'backlog/ops/ (1 ticket) is not a release code in tickets/releases.md — rename it to a listed code or move its tickets to backlog/',
		'backlog/sanjay/ (2 tickets) is not a release code in tickets/releases.md — rename it to a listed code or move its tickets to backlog/',
	]);
});

test('folder names match release codes exactly, case included', async () => {
	const ticketsDir = await makeBoard({ 'backlog/ga': ['d.md'] }, { releases: RELEASES });

	const { errors } = await check(ticketsDir);

	assert.equal(errors.length, 1);
	assert.match(errors[0], /^backlog\/ga\/ \(1 ticket\) is not a release code/);
});

test('a folder named after the current release is an error', async () => {
	const ticketsDir = await makeBoard({ 'backlog/BETA': ['a.md'] }, { releases: RELEASES });

	assert.deepEqual((await check(ticketsDir)).errors, [
		'backlog/BETA/ (1 ticket) is named after the current release BETA — current tickets live directly in backlog/',
	]);
});

test('with a release list naming no releases, every backlog folder is an error', async () => {
	const ticketsDir = await makeBoard({ 'backlog/GA': ['a.md'] }, { releases: '# Releases\n\nNothing planned.\n' });

	assert.deepEqual((await check(ticketsDir)).errors, [
		'backlog/GA/ (1 ticket) is not a release code in tickets/releases.md — rename it to a listed code or move its tickets to backlog/',
	]);
});

test('release-list parse errors are board errors', async () => {
	const ticketsDir = await makeBoard({}, { releases: '## beta\n' });

	assert.deepEqual((await check(ticketsDir)).errors, [
		'tickets/releases.md:1: "beta" is not a release code — use an uppercase letter followed by 1–7 uppercase letters or digits',
	]);
});

test('without releases.md, curated backlog folders are not validated', async () => {
	const ticketsDir = await makeBoard({
		backlog: [['c.md', withHeader('prereq: a')]],
		'backlog/sanjay': ['a.md'],
		'backlog/sanjay/old': ['b.md'],
	});

	assert.deepEqual(await check(ticketsDir), { errors: [], warnings: [] });
});

test('a slug filed both at top level and in a folder is an error naming both paths', async () => {
	const ticketsDir = await makeBoard({ backlog: ['3-session-store.md'], 'backlog/GA': ['session-store.md'], 'backlog/V2': ['other.md'] }, { releases: RELEASES });

	assert.deepEqual((await check(ticketsDir)).errors, [
		'slug "session-store" is filed at backlog/3-session-store.md and backlog/GA/session-store.md — keep one copy',
	]);
});

test('a slug filed in two folders is an error, with or without releases.md', async () => {
	const ticketsDir = await makeBoard({ 'backlog/ops': ['x.md'], 'backlog/sanjay': ['2-x.md'] });

	assert.deepEqual((await check(ticketsDir)).errors, ['slug "x" is filed at backlog/ops/x.md and backlog/sanjay/2-x.md — keep one copy']);
});

test('a directory nested in a release folder is a warning, not an error', async () => {
	const ticketsDir = await makeBoard({ 'backlog/GA': ['a.md'], 'backlog/GA/old': ['b.md'], 'backlog/GA/.cache': [] }, { releases: RELEASES });

	assert.deepEqual(await check(ticketsDir), {
		errors: [],
		warnings: ['backlog/GA/old/ is ignored — tess reads only the tickets directly inside a release folder'],
	});
});

test('a ticket depending on a later release is a sequencing warning, folder tickets included', async () => {
	const ticketsDir = await makeBoard({
		implement: [['export.md', withHeader('prereq: sync-ui')]],
		'backlog/GA': [['sync-ui.md', withHeader('prereq: sync-engine')]],
		'backlog/V2': ['sync-engine.md'],
		complete: [['archived.md', withHeader('prereq: sync-engine')]],  // an archive orders nothing
	}, { releases: RELEASES });

	assert.deepEqual(await check(ticketsDir), {
		errors: [],
		warnings: [
			'implement/export.md: prereq "sync-ui" is deferred to release GA (backlog/GA/) but this ticket is due in BETA — pull the prereq into backlog/ or defer this ticket to backlog/GA/',
			'backlog/GA/sync-ui.md: prereq "sync-engine" is deferred to release V2 (backlog/V2/) but this ticket is due in GA — pull the prereq into backlog/GA/ or defer this ticket to backlog/V2/',
		],
	});
});

// ── ticketProblems ────────────────────────────────────────────────────────

/** `slug → problems` for every implement/ and backlog/ ticket (folders included) on a fixture board. */
async function problemsFor(places, releases) {
	const ticketsDir = await makeBoard(places, { releases });
	const context = await readBoardContext(ticketsDir);
	const tickets = [
		...await discoverTickets(ticketsDir, 'implement', Infinity),
		...await discoverTickets(ticketsDir, 'backlog', Infinity, { includeFolders: true }),
	];
	return Object.fromEntries(tickets.map(t => [t.slug, ticketProblems(t, context)]));
}

test('target: without a releases.md is a problem', async () => {
	assert.deepEqual(await problemsFor({ implement: [['x.md', withHeader('target: GA')]] }), {
		x: ['has target: GA but tickets/releases.md does not exist'],
	});
});

test('target: naming a code the release list does not have is a problem', async () => {
	assert.deepEqual(await problemsFor({ implement: [['x.md', withHeader('target: RC')]] }, RELEASES), {
		x: ['target: RC is not a code in tickets/releases.md'],
	});
});

test('a folder ticket whose target: names a different release is a problem', async () => {
	assert.deepEqual(await problemsFor({ 'backlog/V2': [['x.md', withHeader('target: GA')]] }, RELEASES), {
		x: ['target: GA disagrees with its folder backlog/V2/'],
	});
});

test('a current ticket whose target: names a later release is a problem', async () => {
	assert.deepEqual(await problemsFor({ implement: [['x.md', withHeader('target: GA')]] }, RELEASES), {
		x: ['target: GA is a later release, but implement/ holds current work — move it to backlog/GA/ or drop the field'],
	});
});

test('a ticket with no target:, or one agreeing with its location, has no problems', async () => {
	assert.deepEqual(await problemsFor({
		implement: ['plain.md', ['current.md', withHeader('target: BETA')]],
		backlog: ['top.md'],
		'backlog/GA': [['deferred.md', withHeader('target: GA')]],
	}, RELEASES), { plain: [], current: [], top: [], deferred: [] });
});
