/**
 * `runOneStage`'s gates — the paths that return before any agent, git or
 * log-file work, so they run against a plain temp board.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { runOneStage } from './run-ticket.mjs';
import { readInProgress } from './state.mjs';
import { discoverTickets } from './tickets.mjs';
import { makeBoard, withHeader } from './test-board.mjs';

const contextFor = ticketsDir => ({ ticketsDir, repoRoot: dirname(ticketsDir), opts: {} });

test('a ticket whose header contradicts the board is not runnable, and says so before any prereq gate', async () => {
	// The prereq is behind, so the prereq gate alone would defer this ticket.  The
	// problem must win: waiting on a prereq would hide why the ticket can never run.
	const content = withHeader('prereq: session-store', 'target: GA');
	const ticketsDir = await makeBoard({ implement: [['user-model.md', content]], plan: ['session-store.md'] });
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);

	const outcome = await runOneStage(ticket, contextFor(ticketsDir), { label: '[test]' });

	assert.deepEqual(outcome, { kind: 'invalid', problems: ['has target: GA but tickets/releases.md does not exist'] });
	assert.equal(await readFile(ticket.path, 'utf-8'), content);  // no resume note, nothing written
	assert.ok(!(await readInProgress(ticketsDir)), 'no agent was started, so no in-progress marker');
});

test('a prereq deferred to a later release defers the ticket', async () => {
	const ticketsDir = await makeBoard(
		{ implement: [['user-model.md', withHeader('prereq: session-store')]], 'backlog/GA': ['session-store.md'] },
		{ releases: '## BETA\n## GA\n' },
	);
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);

	const outcome = await runOneStage(ticket, contextFor(ticketsDir), { label: '[test]' });

	assert.deepEqual(outcome, { kind: 'deferred', prereq: 'session-store', prereqStage: 'backlog' });
});

test('a ticket with no anchor is not runnable', async () => {
	const ticketsDir = await makeBoard({ implement: [['bare.md', 'description: x\n----\nbody\n']] });
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);

	const outcome = await runOneStage(ticket, contextFor(ticketsDir), { label: '[test]' });

	assert.deepEqual(outcome, { kind: 'invalid', problems: ['no anchor — add architecture: to the header'] });
});
