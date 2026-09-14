import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { buildPrompt, projectRuleSections } from './prompt.mjs';
import { discoverTickets } from './tickets.mjs';
import { makeBoard, withHeader } from './test-board.mjs';

const CORE_RULES = '# Rules\n\nShared.\n\n<!-- stage:implement -->\nImplement only.\n<!-- /stage -->\n\n<!-- stage:review -->\nReview only.\n<!-- /stage -->\n\nClosing.\n';
/** `CORE_RULES` as an implement-stage prompt carries it. */
const CORE_FOR_IMPLEMENT = '# Rules\n\nShared.\n\nImplement only.\n\nClosing.\n';

/**
 * The prompt for the one implement ticket `x.md` in a temp repo whose tess root
 * holds `CORE_RULES`.  `rules` is the `tickets/rules/` file list, or null for
 * no folder.  No code-search index exists, so no search directive is added.
 */
async function promptFor(rules) {
	const ticketsDir = await makeBoard({ implement: ['x.md'], ...(rules ? { rules } : {}) });
	const repoRoot = dirname(ticketsDir);
	const tessRoot = join(repoRoot, 'tess');
	await mkdir(join(tessRoot, 'agent-rules'), { recursive: true });
	await writeFile(join(tessRoot, 'agent-rules', 'tickets.md'), CORE_RULES, 'utf-8');
	const [ticket] = await discoverTickets(ticketsDir, 'implement', Infinity);
	return { ticket, prompt: await buildPrompt(ticket, tessRoot, repoRoot) };
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
