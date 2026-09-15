import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readBoardContext } from './board-check.mjs';
import { boardCheckLines, buildInventory, inventoryGroups, inventoryText, releaseSummary } from './garden-inventory.mjs';
import { parseReleases } from './releases.mjs';
import { makeBoard, withHeader } from './test-board.mjs';
import { discoverTickets } from './tickets.mjs';

const DAY = 24 * 60 * 60;
const NOW = 1_700_000_000;

/** Discovered backlog tickets (folders included) and the board context of a temp board. */
async function backlog(places, options) {
	const ticketsDir = await makeBoard(places, options);
	return {
		tickets: await discoverTickets(ticketsDir, 'backlog', Infinity, { includeFolders: true }),
		context: await readBoardContext(ticketsDir),
	};
}

async function groupsOf(places, options) {
	const { tickets, context } = await backlog(places, options);
	return inventoryGroups(tickets, context.releases).map(g => [g.heading, g.tickets.map(t => t.file)]);
}

// ── grouping ─────────────────────────────────────────────────────────────

test('without releases.md the top level comes first, then every sub-folder as a curated folder, by name', async () => {
	assert.deepEqual(await groupsOf({ backlog: ['a.md'], 'backlog/ops': ['c.md'], 'backlog/libraries': ['b.md'] }), [
		['backlog/ (no tickets/releases.md)', ['a.md']],
		['backlog/libraries/ (curated folder)', ['b.md']],
		['backlog/ops/ (curated folder)', ['c.md']],
	]);
});

test('with a release list naming no releases, the top level is current and a folder is not a release code', async () => {
	assert.deepEqual(await groupsOf({ backlog: ['a.md'], 'backlog/GA': ['b.md'] }, { releases: '# Releases\n\nNothing planned.\n' }), [
		['backlog/ (tickets/releases.md lists no releases — everything is current)', ['a.md']],
		['backlog/GA/ (not a release code)', ['b.md']],
	]);
});

test('with releases, deferred folders follow the current release in list order, then stray folders by name', async () => {
	const places = {
		backlog: ['2-a.md', 'b.md'],
		'backlog/V2': ['d.md'],
		'backlog/GA': ['c.md'],
		'backlog/sanjay': ['e.md'],
		'backlog/BETA': ['f.md'],
	};

	assert.deepEqual(await groupsOf(places, { releases: '# Releases\n\n## BETA\n\n## GA\n\n## V2\n' }), [
		['Current release (BETA) — backlog/', ['2-a.md', 'b.md']],
		['Deferred to GA — backlog/GA/', ['c.md']],
		['Deferred to V2 — backlog/V2/', ['d.md']],
		['backlog/BETA/ (named after the current release)', ['f.md']],
		['backlog/sanjay/ (not a release code)', ['e.md']],
	]);
});

test('the top-level group is listed even when it is empty', async () => {
	const { tickets, context } = await backlog({ 'backlog/GA': ['later.md'] }, { releases: '## BETA\n\n## GA\n' });
	const inventory = buildInventory(tickets, { ...context, arrivals: new Map(), nowSeconds: NOW, declineAfterDays: 60 });

	assert.deepEqual(inventoryText(inventory.groups).slice(0, 4), ['### Current release (BETA) — backlog/ · 0 tickets', '', '(none)', '']);
	assert.deepEqual(inventory.counts, { top: 0, folders: 1, proposed: 0 });
});

// ── entries ──────────────────────────────────────────────────────────────

test('entries carry triage and anchor columns; age and decline proposals apply to top-level tickets only', async () => {
	const { tickets, context } = await backlog({
		rules: [['anchors.md', '---\nanchor-fields: features\n---\nFeature anchors.\n']],
		backlog: [
			['1-bug-old.md', 'description: old bug\nseverity: cosmetic\ntradeoffs: rarely seen\n----\nbody\n'],
			['2-edge.md', withHeader('tradeoffs: t')],
			['3-young.md', withHeader('tradeoffs: t')],
			['4-feat.md', 'description: f\nfeatures: SIT-BRA\n----\nbody\n'],
			['fresh.md', withHeader()],
		],
		'backlog/GA': [['later.md', withHeader('tradeoffs: t')]],
	}, { releases: '## BETA\n\n## GA\n' });
	const arrivals = new Map([
		['bug-old', NOW - 90 * DAY],
		['edge', NOW - 60 * DAY],
		['young', NOW - 60 * DAY + 1],
		['feat', NOW - DAY],
		['later', NOW - 400 * DAY],
	]);

	const inventory = buildInventory(tickets, { ...context, arrivals, nowSeconds: NOW, declineAfterDays: 60 });

	assert.deepEqual(inventory.counts, { top: 5, folders: 1, proposed: 2 });
	assert.deepEqual(inventoryText(inventory.groups), [
		'### Current release (BETA) — backlog/ · 5 tickets',
		'',
		'- 1-bug-old.md — old bug\n  [severity: cosmetic | likelihood: MISSING | tradeoffs: present | anchor: MISSING | age: 90d | PROPOSE-DECLINE]',
		'- 2-edge.md — x\n  [tradeoffs: present | anchor: present | age: 60d | PROPOSE-DECLINE]',
		'- 3-young.md — x\n  [tradeoffs: present | anchor: present | age: 59d]',
		'- 4-feat.md — f\n  [tradeoffs: MISSING | anchor: present | age: 1d]',
		'- fresh.md — x\n  [tradeoffs: MISSING | anchor: present | age: new]',
		'',
		'### Deferred to GA — backlog/GA/ · 1 ticket',
		'',
		'- GA/later.md — x\n  [tradeoffs: present | anchor: present]',
		'',
	]);
});

test('a board with no addendum declaring anchor fields has no anchor column', async () => {
	const { tickets, context } = await backlog({ backlog: [['a.md', withHeader('tradeoffs: t')]] }, { releases: '## BETA\n' });
	const inventory = buildInventory(tickets, { ...context, arrivals: new Map(), nowSeconds: NOW, declineAfterDays: 60 });

	assert.deepEqual(inventoryText(inventory.groups).slice(0, 4), [
		'### Current release (BETA) — backlog/ · 1 ticket',
		'',
		'- a.md — x\n  [tradeoffs: present | age: new]',
		'',
	]);
});

// ── summaries ────────────────────────────────────────────────────────────

test('the release summary says whether the model is off, empty, or which release is current', () => {
	assert.equal(releaseSummary({ present: false, entries: [] }), 'Release list: none — no tickets/releases.md, so there is no release tier and backlog sub-folders are curated folders');
	assert.equal(releaseSummary({ present: true, ...parseReleases('# Releases\n') }), 'Release list: tickets/releases.md lists no releases — everything is current');
	assert.equal(releaseSummary({ present: true, ...parseReleases('## BETA\ndue: 2026-11-01\n\n## GA\n\n## V2\ndue: 2027-06-30\n') }), 'Release list: BETA (current, due 2026-11-01), GA, V2 (due 2027-06-30)');
});

test('board check lines list errors before warnings, and nothing for a clean board', () => {
	assert.deepEqual(boardCheckLines({ errors: [], warnings: [] }), []);
	assert.deepEqual(boardCheckLines({ errors: ['e1'], warnings: ['w1', 'w2'] }), ['Errors:', '- e1', 'Warnings:', '- w1', '- w2']);
	assert.deepEqual(boardCheckLines({ errors: [], warnings: ['w1'] }), ['Warnings:', '- w1']);
});
