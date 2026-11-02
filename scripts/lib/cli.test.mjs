import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseStages, stageOrderViolation } from './cli.mjs';
import { PENDING_STAGES } from './tickets.mjs';

// README § Options, `--stages`: a list that puts a stage ahead of one later in the pipeline is
// refused; `fix` and `plan` may come in either order.
test('a --stages list is out of order only where a stage precedes one later in the pipeline', () => {
	const cases = [
		[PENDING_STAGES.join(','), null],
		['fix,plan', null],
		['plan,fix', null],
		['review:5,implement:3,fix,backlog:2', null],
		['implement,blocked,review', { earlier: 'implement', later: 'review' }],
		['plan,implement', { earlier: 'plan', later: 'implement' }],
		['plan,implement,fix,review,backlog', { earlier: 'plan', later: 'implement' }],
		['review,backlog,plan', { earlier: 'backlog', later: 'plan' }],
	];
	for (const [raw, expected] of cases) {
		assert.deepEqual(stageOrderViolation(parseStages(raw, Infinity)), expected, raw);
	}
});
