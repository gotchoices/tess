import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTriagePrompt } from './pre-existing-error.mjs';
import { anchorFieldsOf, readProjectRules } from './project-rules.mjs';
import { makeBoard } from './test-board.mjs';

test('the triage prompt requires a filed fix/ ticket to carry one of the anchor fields the board accepts', async () => {
	const ticketsDir = await makeBoard({ rules: [['rubric.md', '---\nanchor-fields: features, aspects\n---\n']] });
	const anchorFields = anchorFieldsOf((await readProjectRules(ticketsDir)).rules);

	const prompt = buildTriagePrompt('failing test report', anchorFields);

	assert.match(prompt, /plus at least one anchor field \(`architecture:`, `features:`, `aspects:`\)/);
	assert.match(prompt, /## Report\n\nfailing test report$/);
});

test('with no anchor fields the triage prompt asks for none and offers architecture: as optional', () => {
	const prompt = buildTriagePrompt('failing test report', []);

	assert.doesNotMatch(prompt, /at least one anchor field/);
	assert.match(prompt, /`architecture:` line naming the project's testing document is\n\s+welcome but not required/);
});
