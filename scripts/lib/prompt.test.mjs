import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { readBoardContext } from './board-check.mjs';
import { buildInventory } from './garden-inventory.mjs';
import { buildGardenPrompt, buildPrompt, projectRuleSections } from './prompt.mjs';
import { discoverTickets } from './tickets.mjs';
import { makeBoard, withHeader } from './test-board.mjs';

const CORE_RULES = '# Rules\n\nShared.\n\n<!-- stage:implement -->\nImplement only.\n<!-- /stage -->\n\n<!-- stage:review -->\nReview only.\n<!-- /stage -->\n\nClosing.\n';
/** `CORE_RULES` as an implement-stage prompt carries it. */
const CORE_FOR_IMPLEMENT = '# Rules\n\nShared.\n\nImplement only.\n\nClosing.\n';
/** `CORE_RULES` as the gardener's prompt carries it: every stage block stripped. */
const CORE_FOR_GARDEN = '# Rules\n\nShared.\n\nClosing.\n';
const GARDEN_RULES = '# Garden\n\nGarden rules.\n';

const DAY = 24 * 60 * 60;
const NOW = 1_700_000_000;

/** A temp tess root holding `CORE_RULES` and `GARDEN_RULES`, beside a board's tickets/ folder. */
async function tessRootBeside(ticketsDir) {
	const tessRoot = join(dirname(ticketsDir), 'tess');
	await mkdir(join(tessRoot, 'agent-rules'), { recursive: true });
	await writeFile(join(tessRoot, 'agent-rules', 'tickets.md'), CORE_RULES, 'utf-8');
	await writeFile(join(tessRoot, 'agent-rules', 'garden.md'), GARDEN_RULES, 'utf-8');
	return tessRoot;
}

/**
 * The prompt for the one implement ticket `x.md` in a temp repo whose tess root
 * holds `CORE_RULES`.  `rules` is the `tickets/rules/` file list, or null for
 * no folder.  No code-search index exists, so no search directive is added.
 */
async function promptFor(rules) {
	const ticketsDir = await makeBoard({ implement: ['x.md'], ...(rules ? { rules } : {}) });
	const tessRoot = await tessRootBeside(ticketsDir);
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);
	return { ticket, prompt: await buildPrompt(ticket, tessRoot, dirname(ticketsDir)) };
}

/** The prompt layout as it was before project rules existed, with `addenda` lines spliced in after the core rules. */
function expectedPrompt(ticket, addenda = []) {
	return [
		'# Ticket: x.md (stage: implement, sequence: --)',
		'# Next stage: review',
		'',
		'## Ticket workflow rules:',
		'',
		CORE_FOR_IMPLEMENT,
		...addenda,
		'',
		`## Contents of \`${ticket.path}\`:`,
		'',
		withHeader(),
		'',
		'## End',
		'Work ticket as described above.',
		'Do NOT commit — runner handles commits after you complete.',
	].join('\n');
}

test('with no tickets/rules/ folder, or an empty one, the prompt is exactly the layout it had before project rules', async () => {
	const absent = await promptFor(null);
	const empty = await promptFor([]);

	assert.equal(absent.prompt, expectedPrompt(absent.ticket));
	assert.equal(empty.prompt, expectedPrompt(empty.ticket));
});

test('addenda follow the core rules in filename order, stage-filtered, and a declaration-only file adds no heading', async () => {
	const { ticket, prompt } = await promptFor([
		['b-plain.md', 'Plain rule, every stage.\n'],
		['a-staged.md', '---\nanchor-fields: features\n---\nAll stages.\n\n<!-- stage:implement -->\nImplement addendum.\n<!-- /stage -->\n<!-- stage:review -->\nReview addendum.\n<!-- /stage -->\n'],
		['c-declares-only.md', '---\nanchor-fields: aspects\n---\n'],
	]);

	assert.equal(prompt, expectedPrompt(ticket, [
		'', '## Project rules (tickets/rules/a-staged.md)', '', 'All stages.\n\nImplement addendum.',
		'', '## Project rules (tickets/rules/b-plain.md)', '', 'Plain rule, every stage.',
	]));
});

test('for the gardener (no stage) every stage block is stripped from an addendum', () => {
	const rules = [{ name: 'r.md', body: 'Shared.\n<!-- stage:plan -->\nPlan only.\n<!-- /stage -->\n', anchorFields: [] }];

	assert.deepEqual(projectRuleSections(rules, null), ['', '## Project rules (tickets/rules/r.md)', '', 'Shared.']);
});

test('an addendum with no block for the ticket\'s stage is carried whole, markers included — filterStageBlocks\' rule for tickets.md', () => {
	const body = 'Shared.\n<!-- stage:review -->\nReview only.\n<!-- /stage -->';

	assert.deepEqual(projectRuleSections([{ name: 'r.md', body, anchorFields: [] }], 'plan'), ['', '## Project rules (tickets/rules/r.md)', '', body]);
});

// ── buildGardenPrompt ────────────────────────────────────────────────────

const NO_FEEDBACK = 'None provided this pass — consolidate, backfill, rank, and propose declines only. Do NOT decline, promote, defer, or pull forward any ticket.';

/**
 * The gardener's prompt for a board with `backlog/a.md` (60 days at the top
 * level), `backlog/GA/b.md`, a BETA/GA release list and one addendum.
 */
async function gardenPromptFor({ board, feedback }) {
	const ticketsDir = await makeBoard({
		backlog: ['a.md'],
		'backlog/GA': ['b.md'],
		rules: [['r.md', 'Addendum.\n<!-- stage:plan -->\nPlan only.\n<!-- /stage -->\n']],
	}, { releases: '## BETA\n\n## GA\n' });
	const tessRoot = await tessRootBeside(ticketsDir);
	const context = await readBoardContext(ticketsDir);
	const tickets = await discoverTickets(ticketsDir, 'backlog', Infinity, { includeFolders: true });
	const inventory = buildInventory(tickets, {
		releases: context.releases,
		anchorFields: context.anchorFields,
		anchorsRequired: context.anchorsRequired,
		arrivals: new Map([['a', NOW - 60 * DAY]]),
		nowSeconds: NOW,
		declineAfterDays: 60,
	});
	return buildGardenPrompt(tessRoot, dirname(ticketsDir), {
		inventory,
		releases: context.releases,
		rules: context.rules.rules,
		board,
		declineAfterDays: 60,
		feedback,
	});
}

/** The gardener's prompt for `gardenPromptFor`'s board, with `boardSection` lines before the inventory. */
function expectedGardenPrompt({ boardSection = [], feedback }) {
	return [
		'# Backlog gardening pass — 2 ticket(s) in tickets/backlog/ (1 at the top level, 1 in sub-folders)',
		'',
		'## Gardening rules:',
		'',
		GARDEN_RULES,
		'',
		'## Shared workflow conventions (stage-specific blocks removed):',
		'',
		CORE_FOR_GARDEN,
		'', '## Project rules (tickets/rules/r.md)', '', 'Addendum.',
		...boardSection,
		'',
		'## Backlog inventory (headers only — read the full files you act on):',
		'',
		'Release list: BETA (current), GA',
		'Paths are relative to tickets/backlog/. `age` is whole days since the ticket arrived at the top level of backlog/, read from git history (`new`: no commit has put it there yet). `PROPOSE-DECLINE` marks an age of 60 days or more.',
		'',
		'### Current release (BETA) — backlog/ · 1 ticket',
		'',
		'- a.md — x\n  [tradeoffs: MISSING | age: 60d | PROPOSE-DECLINE]',
		'',
		'### Deferred to GA — backlog/GA/ · 1 ticket',
		'',
		'- GA/b.md — x\n  [tradeoffs: MISSING]',
		'',
		'## Human feedback:',
		'',
		feedback,
		'',
		'## End',
		'Work the gardening pass as described above.',
		'Do NOT commit — the runner handles the commit after you complete.',
	].join('\n');
}

test('the gardener prompt carries its rules, stage-stripped conventions and addenda, the grouped inventory, and forbids every move without feedback', async () => {
	const prompt = await gardenPromptFor({ board: { errors: [], warnings: [] }, feedback: null });

	assert.equal(prompt, expectedGardenPrompt({ feedback: NO_FEEDBACK }));
});

test('board check findings get their own section before the inventory, and given feedback replaces the prohibition', async () => {
	const prompt = await gardenPromptFor({ board: { errors: ['e1'], warnings: ['w1'] }, feedback: 'Defer a to GA.' });

	assert.equal(prompt, expectedGardenPrompt({
		boardSection: [
			'',
			'## Board check',
			'',
			'The runner\'s startup board check finds these on the current board. Report them; do not rename folders or move tickets to clear them.',
			'',
			'Errors:',
			'- e1',
			'Warnings:',
			'- w1',
		],
		feedback: 'Defer a to GA.',
	}));
});

test('a review: skip ticket is told its next stage is complete, and told to override the review handoff', async () => {
	const ticketsDir = await makeBoard({ implement: [['x.md', withHeader('review: skip')]] });
	const tessRoot = await tessRootBeside(ticketsDir);
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);

	const prompt = await buildPrompt(ticket, tessRoot, dirname(ticketsDir));

	assert.match(prompt, /^# Next stage: complete$/m);
	assert.match(prompt, /## Review stage skipped for this ticket/);
	assert.match(prompt, /write the `complete\/` ticket instead/);
	// Late in the prompt, after the stage rules it is overriding.
	assert.ok(prompt.indexOf('## Review stage skipped') > prompt.indexOf('Implement only.'));
});

test('an ordinary implement ticket gets neither the complete next-stage line nor the override section', async () => {
	const { prompt } = await promptFor(null);

	assert.match(prompt, /^# Next stage: review$/m);
	assert.doesNotMatch(prompt, /Review stage skipped/);
});
