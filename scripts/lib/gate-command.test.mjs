import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runGateCommand } from './gate-command.mjs';

test('runGateCommand runs the command with the given cwd and env, and reports ok on a zero exit', () => {
	let seen = null;
	const exec = (cmd, opts) => { seen = { cmd, opts }; return ''; };

	const result = runGateCommand('yarn gate', { cwd: '/repo', env: { FOO: 'bar' } }, { exec });

	assert.deepEqual(result, { ok: true });
	assert.equal(seen.cmd, 'yarn gate');
	assert.equal(seen.opts.cwd, '/repo');
	assert.equal(seen.opts.env.FOO, 'bar');
});

test('runGateCommand reports ok: false with the command\'s combined output on a non-zero exit', () => {
	const exec = () => {
		const err = new Error('Command failed');
		err.stdout = 'stdout line\n';
		err.stderr = 'stderr line\n';
		throw err;
	};

	const result = runGateCommand('yarn gate', { cwd: '/repo', env: {} }, { exec });

	assert.deepEqual(result, { ok: false, output: 'stdout line\n\nstderr line' });
});

test('runGateCommand falls back to the error message when the failure carries no stdout or stderr', () => {
	const exec = () => { throw new Error('spawn ENOENT'); };

	const result = runGateCommand('does-not-exist', { cwd: '/repo', env: {} }, { exec });

	assert.deepEqual(result, { ok: false, output: 'spawn ENOENT' });
});
