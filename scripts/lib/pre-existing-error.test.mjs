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
