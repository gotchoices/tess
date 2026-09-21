/**
 * Live strategy selection (`pickNext`), against temp boards.  The run loop
 * itself invokes agents and is not exercised here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickNext } from './strategies/live.mjs';
import { discoverTickets, indexAllTickets } from './tickets.mjs';
import { topoSortAndCheck } from './topo.mjs';
import { makeBoard, withHeader } from './test-board.mjs';

/** The live queue for `stages`, built the way the strategy builds it. */
async function liveQueue(ticketsDir, stages) {
	const queue = [];
	for (const stage of stages) queue.push(...topoSortAndCheck(await discoverTickets(ticketsDir, stage, Infinity)));
	return queue;
}

async function pickWith(ticketsDir, stages, excluded, only = null) {
	return pickNext(await liveQueue(ticketsDir, stages), {
		ticketsDir,
		index: await indexAllTickets(ticketsDir),
		excluded: new Set(excluded),
		transitions: new Map(),
		only,
	});
}

test('a same-stage dependent of an excluded ticket is held for the run, down the whole chain', async () => {
	// implement/a was not runnable (or errored).  b and c pass the rank gate — same stage — so
	// only the hold keeps them from running ahead of work that has not landed.
	const ticketsDir = await makeBoard({
		implement: ['1-a.md', ['2-b.md', withHeader('prereq: a')], ['3-c.md', withHeader('prereq: b')]],
		plan: ['d.md'],
	});

	const pick = await pickWith(ticketsDir, ['implement', 'plan'], ['a']);

	assert.equal(pick?.slug, 'd');
});

test('a same-stage dependent of a ticket still waiting on an earlier stage is not picked ahead of it', async () => {
	// implement/p waits on fix/q, so this pass skips it.  implement/d needs p and passes the rank
	// gate (same stage), so without the hold d would be implemented, and reviewed, before p.
	const ticketsDir = await makeBoard({
		implement: [['1-p.md', withHeader('prereq: q')], ['2-d.md', withHeader('prereq: p')]],
		fix: ['q.md'],
	});

	const pick = await pickWith(ticketsDir, ['implement', 'fix'], []);

	assert.equal(pick?.slug, 'q');
});

test('an earlier-stage dependent of an excluded ticket is left to the rank gate', async () => {
	// review/a errored after its implementation landed; implement/b, which needed that, may run.
	const ticketsDir = await makeBoard({ review: ['a.md'], implement: [['b.md', withHeader('prereq: a')]] });

	const pick = await pickWith(ticketsDir, ['review', 'implement'], ['a']);

	assert.equal(pick?.slug, 'b');
});

test('--only skips a higher-priority ticket that was not named', async () => {
	// implement/a would normally win the rank gate over plan/b, but --only names
	// just b: an operator hand-assigning specific tickets to a runner.
	const ticketsDir = await makeBoard({ implement: ['a.md'], plan: ['b.md'] });

	const pick = await pickWith(ticketsDir, ['implement', 'plan'], [], new Set(['b']));

	assert.equal(pick?.slug, 'b');
});

test('a ticket whose prereq is deferred to a later release is never picked', async () => {
	const ticketsDir = await makeBoard(
		{ implement: [['a.md', withHeader('prereq: later')]], 'backlog/GA': ['later.md'] },
		{ releases: '## BETA\n## GA\n' },
	);

	assert.equal(await pickWith(ticketsDir, ['implement'], []), null);
});
